import os
import uuid
from typing import Optional
from fastapi import FastAPI, Depends, Form, File, UploadFile, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
from contextlib import asynccontextmanager

from app.db import init_db, get_db
from app.auth import verify_google_token, create_session_token, get_current_user_id
from app.compression import compress_and_save, decompress_and_stream, is_gzip_file
import re
import json
import zipfile
import gzip
from threading import Lock

try:
    import pymupdf as fitz  # type: ignore
    HAS_FITZ = True
except ImportError:
    try:
        import fitz  # type: ignore
        HAS_FITZ = True
    except ImportError:
        HAS_FITZ = False
        fitz = None  # type: ignore

_decompress_lock = Lock()



# Setup directories relative to the backend root
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
COVERS_DIR = os.path.join(BASE_DIR, "covers")

os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(COVERS_DIR, exist_ok=True)

LIBRARY_STORAGE_DIR = "/mnt/library_storage"

def get_storage_path(book_id: str, book_type: str) -> str:
    if book_type == "epub":
        return os.path.join(LIBRARY_STORAGE_DIR, "binaries", "epubs", f"{book_id}.epub")
    elif book_type == "pdf":
        return os.path.join(LIBRARY_STORAGE_DIR, "binaries", "pdfs", f"{book_id}.pdf")
    elif book_type in ["manga", "cbz", "zip"]:
        return os.path.join(LIBRARY_STORAGE_DIR, "manga", book_id)
    else:
        return os.path.join(LIBRARY_STORAGE_DIR, "binaries", f"{book_id}.{book_type}")

def sanitize_path_segment(name: str) -> str:
    import re
    sanitized = re.sub(r'[^a-zA-Z0-9_\-]', '_', name)
    return sanitized if sanitized else "default"

def delete_book_files_from_storage(book_id: str, book_type: str):
    import shutil
    path = get_storage_path(book_id, book_type)
    try:
        if book_type in ["manga", "cbz", "zip"]:
            if os.path.exists(path):
                shutil.rmtree(path)
        else:
            if os.path.exists(path):
                os.remove(path)
    except OSError as e:
        print(f"Error deleting book {book_id} from storage: {e}")

def natural_sort_key(s):
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]

def get_manga_pages_from_zip(file_path_or_bytes) -> list:
    pages = []
    try:
        with zipfile.ZipFile(file_path_or_bytes) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                filename = info.filename
                basename = os.path.basename(filename)
                if basename.startswith('.') or basename.startswith('__MACOSX') or basename.lower() == 'thumbs.db':
                    continue
                ext = os.path.splitext(filename)[1].lower()
                if ext in ['.png', '.jpg', '.jpeg', '.webp', '.gif']:
                    pages.append(filename)
        pages.sort(key=natural_sort_key)
    except Exception as e:
        print(f"Error reading zip: {e}")
    return pages

def ensure_decompressed(file_path: str):
    """
    If a file is gzip compressed, permanently decompresses it on disk to avoid
    the high CPU/memory overhead of decompressing it on every page request.
    """
    if is_gzip_file(file_path):
        with _decompress_lock:
            if is_gzip_file(file_path):
                temp_path = file_path + ".tmp"
                try:
                    with gzip.open(file_path, "rb") as gf:
                        with open(temp_path, "wb") as df:
                            while True:
                                chunk = gf.read(1024 * 1024)
                                if not chunk:
                                    break
                                df.write(chunk)
                    os.replace(temp_path, file_path)
                except Exception as e:
                    if os.path.exists(temp_path):
                        try:
                            os.remove(temp_path)
                        except Exception:
                            pass
                    raise e

def generate_cover_backend(file_bytes: bytes, book_type: str, cover_path: str) -> bool:
    """
    Renders/extracts the cover image (page 1) of a PDF or ZIP book.
    """
    try:
        import io
        if book_type == "pdf" and HAS_FITZ and fitz is not None:
            doc = fitz.open(stream=io.BytesIO(file_bytes), filetype="pdf")
            if len(doc) > 0:
                page = doc[0]
                pix = page.get_pixmap(matrix=fitz.Matrix(0.6, 0.6))
                os.makedirs(os.path.dirname(cover_path), exist_ok=True)
                pix.save(cover_path)
                doc.close()
                return True
        elif book_type in ["manga", "cbz", "zip"]:
            with zipfile.ZipFile(io.BytesIO(file_bytes)) as z:
                images = [
                    info.filename for info in z.infolist()
                    if not info.is_dir() and 
                    os.path.basename(info.filename).lower().endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif')) and
                    not os.path.basename(info.filename).startswith('.') and
                    not info.filename.startswith('__MACOSX')
                ]
                if images:
                    images.sort(key=natural_sort_key)
                    first_img_name = images[0]
                    img_data = z.read(first_img_name)
                    os.makedirs(os.path.dirname(cover_path), exist_ok=True)
                    with open(cover_path, "wb") as f:
                        f.write(img_data)
                    return True
    except Exception as e:
        print(f"Backend cover generation failed: {e}")
    return False

import datetime

def cleanup_expired_guests():
    try:
        # Expire guest sessions older than 7 days of inactivity (matches frontend TTL)
        threshold_dt = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)
        from app.db import IS_POSTGRES
        if IS_POSTGRES:
            threshold = threshold_dt
        else:
            # SQLite comparison relies on string matching format: YYYY-MM-DD HH:MM:SS
            threshold = threshold_dt.strftime("%Y-%m-%d %H:%M:%S")
            
        with get_db() as conn:
            # 1. Fetch books to delete from disk
            books = conn.execute("""
                SELECT id, type, cover_path FROM books 
                WHERE user_id LIKE 'guest_%' AND last_read_at < ?;
            """, (threshold,)).fetchall()
            
            deleted_count = 0
            for book in books:
                delete_book_files_from_storage(book["id"], book["type"])
                deleted_count += 1
                if book["cover_path"]:
                    cover_filename = os.path.basename(book["cover_path"])
                    cover_path = os.path.join(COVERS_DIR, cover_filename)
                    if os.path.exists(cover_path):
                        os.remove(cover_path)
            
            # 2. Purge DB records
            conn.execute("DELETE FROM books WHERE user_id LIKE 'guest_%' AND last_read_at < ?;", (threshold,))
            conn.execute("DELETE FROM users WHERE id LIKE 'guest_%' AND created_at < ?;", (threshold,))
            
            if deleted_count > 0:
                print(f"Database Cleanup: Purged {deleted_count} expired guest files.")
    except Exception as e:
        print(f"Database Cleanup Error: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize SQLite database
    init_db()
    # Ensure library storage directories exist
    try:
        os.makedirs(os.path.join(LIBRARY_STORAGE_DIR, "binaries", "epubs"), exist_ok=True)
        os.makedirs(os.path.join(LIBRARY_STORAGE_DIR, "binaries", "pdfs"), exist_ok=True)
        os.makedirs(os.path.join(LIBRARY_STORAGE_DIR, "manga"), exist_ok=True)
    except OSError as e:
        print(f"Warning: Failed to initialize storage directories: {e}")
    # Cleanup expired guest folders
    cleanup_expired_guests()
    yield

app = FastAPI(
    title="PDF & Manga Reader API",
    version="1.0.0",
    lifespan=lifespan
)

# Configure CORS with environment-based allowed origins (wildcard is not permitted with allow_credentials)
origins = []
allowed_origins_env = os.environ.get("ALLOWED_ORIGINS", "")
if allowed_origins_env:
    origins = [origin.strip() for origin in allowed_origins_env.split(",") if origin.strip()]
else:
    # Default to local development origins
    origins = [
        "http://localhost:5173",
        "http://localhost:8000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:8000",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True if "*" not in origins else False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    
    # 1. Content-Security-Policy (CSP)
    csp_directives = [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://apis.google.com https://cdnjs.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
        "img-src 'self' data: blob: https://lh3.googleusercontent.com https://ssl.gstatic.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "frame-src 'self' https://accounts.google.com",
        "connect-src 'self' https://accounts.google.com",
        "worker-src 'self' blob: https://cdnjs.cloudflare.com"
    ]
    response.headers["Content-Security-Policy"] = "; ".join(csp_directives)
    
    # 2. Referrer-Policy
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    
    # 3. Strict-Transport-Security (HSTS)
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"
    
    # 4. X-Content-Type-Options
    response.headers["X-Content-Type-Options"] = "nosniff"
    
    # 5. X-Frame-Options (Clickjacking defense)
    response.headers["X-Frame-Options"] = "DENY"
    
    return response

# Mount covers folder to serve cover images statically
app.mount("/covers", StaticFiles(directory=COVERS_DIR), name="covers")

class GoogleLoginRequest(BaseModel):
    id_token: str
    guest_id: Optional[str] = None  # current guest session to merge into the real account

class ProgressUpdateRequest(BaseModel):
    current_page: int
    zoom: float
    view_mode: str
    scroll_position: int
    reading_direction: str

@app.post("/api/auth/google")
async def google_auth(req: GoogleLoginRequest):
    """
    Verifies a Google credential token, registers/gets user in SQLite, and returns a session JWT.
    If guest_id is provided, all books belonging to that guest are reassigned to the real account.
    """
    try:
        user_info = verify_google_token(req.id_token)
        user_id = user_info["id"]
        
        with get_db() as conn:
            # 1. Save or update user in SQLite
            conn.execute("""
                INSERT INTO users (id, email, name, picture)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    email=excluded.email,
                    name=excluded.name,
                    picture=excluded.picture;
            """, (user_id, user_info["email"], user_info["name"], user_info["picture"]))

            # 2. Merge guest books into the real account if a valid guest_id was supplied
            merged_count = 0
            if req.guest_id and req.guest_id.startswith("guest_"):
                result = conn.execute(
                    "UPDATE books SET user_id = ? WHERE user_id = ?;",
                    (user_id, req.guest_id)
                )
                merged_count = result.rowcount
                # Clean up the now-empty guest user record
                conn.execute("DELETE FROM users WHERE id = ?;", (req.guest_id,))

        # 3. Create backend JWT session token
        session_token = create_session_token(user_id)

        return {
            "token": session_token,
            "merged_books": merged_count,
            "user": {
                "id": user_id,
                "email": user_info["email"],
                "name": user_info["name"],
                "picture": user_info["picture"]
            }
        }
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=400, detail=f"Authentication failed: {str(e)}")

@app.get("/api/auth/config")
async def get_config():
    """
    Returns public config info, specifically Google Client ID if set.
    """
    from app.auth import GOOGLE_CLIENT_ID
    client_id = GOOGLE_CLIENT_ID
    if not client_id or "your-google-client-id-here" in client_id:
        client_id = ""
    return {"google_client_id": client_id}

@app.get("/api/auth/me")
async def get_me(user_id: str = Depends(get_current_user_id)):
    """
    Returns profile information of the current authenticated user.
    """
    with get_db() as conn:
        user = conn.execute("SELECT * FROM users WHERE id = ?;", (user_id,)).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        return user

@app.post("/api/auth/logout")
async def logout(user_id: str = Depends(get_current_user_id)):
    """
    Deletes the guest session data and uploaded files immediately when logging out.
    """
    if user_id.startswith("guest_"):
        try:
            with get_db() as conn:
                # 1. Find and delete files
                books = conn.execute(
                    "SELECT id, type, cover_path FROM books WHERE user_id = ?;", 
                    (user_id,)
                ).fetchall()
                
                for book in books:
                    delete_book_files_from_storage(book["id"], book["type"])
                    if book["cover_path"]:
                        cover_filename = os.path.basename(book["cover_path"])
                        cover_path = os.path.join(COVERS_DIR, cover_filename)
                        if os.path.exists(cover_path):
                            os.remove(cover_path)
                
                # 2. Delete database entries
                conn.execute("DELETE FROM books WHERE user_id = ?;", (user_id,))
                conn.execute("DELETE FROM users WHERE id = ?;", (user_id,))
                
            return {"status": "success", "message": "Guest session data purged successfully"}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to clear guest session: {str(e)}")
            
    return {"status": "success", "message": "Logged out successfully"}

@app.get("/api/books")
async def get_books(user_id: str = Depends(get_current_user_id)):
    """
    Lists all books matching the current user context.
    """
    with get_db() as conn:
        books = conn.execute(
            "SELECT * FROM books WHERE user_id = ? ORDER BY last_read_at DESC;",
            (user_id,)
        ).fetchall()
        return books

@app.post("/api/books")
async def upload_book(
    title: str = Form(...),
    type: str = Form(...),
    total_pages: int = Form(...),
    file: UploadFile = File(...),
    cover: Optional[UploadFile] = File(None),
    convert_to_epub: bool = Form(False),
    user_id: str = Depends(get_current_user_id)
):
    """
    Uploads a new book/manga. Files are stored in NFS library storage.
    Covers are saved in covers/ directory.
    """
    book_id = str(uuid.uuid4())
    
    file_bytes = await file.read()
    final_type = type
    final_file_bytes = file_bytes
    final_total_pages = total_pages
    
    if type == "pdf" and convert_to_epub:
        try:
            from app.epub_converter import convert_pdf_to_epub
            final_file_bytes = convert_pdf_to_epub(file_bytes, title)
            final_type = "epub"
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"PDF to EPUB conversion failed: {str(e)}")

    cover_url_path = ""
    cover_name = f"{book_id}.jpg"
    cover_path = os.path.join(COVERS_DIR, cover_name)
    
    # Save cover if provided
    if cover:
        cover_bytes = await cover.read()
        try:
            os.makedirs(os.path.dirname(cover_path), exist_ok=True)
            with open(cover_path, "wb") as f:
                f.write(cover_bytes)
            cover_url_path = f"/covers/{cover_name}"
        except OSError as e:
            print(f"Error saving uploaded cover: {e}")

    page_manifest_json = None
    
    # Process files according to format type
    if final_type in ["manga", "cbz", "zip"]:
        # Manga Extraction Task
        import tempfile
        import shutil
        from PIL import Image
        
        tmp_base = "/tmp"
        try:
            os.makedirs(tmp_base, exist_ok=True)
        except OSError:
            tmp_base = tempfile.gettempdir()
            
        zip_tmp_path = os.path.join(tmp_base, f"{book_id}.zip")
        extract_dir = os.path.join(tmp_base, f"manga_extract_{book_id}")
        
        try:
            # Write zip to temp file
            with open(zip_tmp_path, "wb") as f:
                f.write(final_file_bytes)
                
            # Extract zip contents
            os.makedirs(extract_dir, exist_ok=True)
            with zipfile.ZipFile(zip_tmp_path, "r") as z:
                z.extractall(extract_dir)
                
            # Recursively find image files
            image_files = []
            for root, dirs, files in os.walk(extract_dir):
                for file_entry in files:
                    basename = os.path.basename(file_entry)
                    if basename.startswith('.') or basename.lower() == 'thumbs.db':
                        continue
                    ext = os.path.splitext(file_entry)[1].lower()
                    if ext in ['.png', '.jpg', '.jpeg', '.webp', '.gif']:
                        full_path = os.path.join(root, file_entry)
                        rel_path = os.path.relpath(full_path, extract_dir)
                        image_files.append((rel_path, full_path))
                        
            # Sort images naturally
            image_files.sort(key=lambda x: natural_sort_key(x[0]))
            
            pages_list = []
            for rel_path, full_path in image_files:
                # Normalize relative path separators
                rel_path_norm = rel_path.replace(os.sep, '/')
                parts = rel_path_norm.split('/')
                
                # Determine chapter_id
                if len(parts) > 1:
                    chapter_id = "_".join(parts[:-1])
                else:
                    chapter_id = "1"
                    
                # Determine page_number
                base_name = parts[-1]
                page_number = os.path.splitext(base_name)[0]
                
                # Sanitize path segments
                chapter_id = sanitize_path_segment(chapter_id)
                page_number = sanitize_path_segment(page_number)
                
                # Write converted WebP output
                nfs_manga_dir = os.path.join(LIBRARY_STORAGE_DIR, "manga", book_id, chapter_id)
                os.makedirs(nfs_manga_dir, exist_ok=True)
                dest_webp_path = os.path.join(nfs_manga_dir, f"{page_number}.webp")
                
                try:
                    with Image.open(full_path) as img:
                        img.save(dest_webp_path, "WEBP")
                    pages_list.append(f"{chapter_id}/{page_number}.webp")
                except Exception as e:
                    print(f"Failed to convert image {rel_path} to WebP: {e}")
                    raise HTTPException(
                        status_code=500,
                        detail=f"Failed to process and convert manga page: {str(e)}"
                    )
            
            final_total_pages = len(pages_list)
            page_manifest_json = json.dumps(pages_list)
            db_file_path = f"manga/{book_id}"
            
            # Generate cover if not uploaded
            if not cover and image_files:
                first_img_path = image_files[0][1]
                try:
                    os.makedirs(os.path.dirname(cover_path), exist_ok=True)
                    with Image.open(first_img_path) as img:
                        if img.mode != "RGB":
                            img = img.convert("RGB")
                        img.save(cover_path, "JPEG")
                        cover_url_path = f"/covers/{cover_name}"
                except Exception as e:
                    print(f"Failed to generate cover for manga: {e}")
                    
        finally:
            # Cleanup temp files
            try:
                if os.path.exists(zip_tmp_path):
                    os.remove(zip_tmp_path)
                if os.path.exists(extract_dir):
                    shutil.rmtree(extract_dir)
            except Exception as e:
                print(f"Failed to clean up temp files: {e}")
                
    else:
        # PDF or EPUB Binary storage
        db_file_path = f"binaries/epubs/{book_id}.epub" if final_type == "epub" else f"binaries/pdfs/{book_id}.pdf"
        dest_path = get_storage_path(book_id, final_type)
        
        try:
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            with open(dest_path, "wb") as f:
                f.write(final_file_bytes)
        except OSError as e:
            raise HTTPException(
                status_code=503,
                detail=f"Failed to write binary file to storage: {str(e)}"
            )
            
        # Generate cover if not uploaded
        if not cover:
            try:
                os.makedirs(os.path.dirname(cover_path), exist_ok=True)
                if generate_cover_backend(final_file_bytes, final_type, cover_path):
                    cover_url_path = f"/covers/{cover_name}"
            except Exception as e:
                print(f"Failed to generate cover for binary: {e}")

    # 3. Save to database
    with get_db() as conn:
        conn.execute("""
            INSERT INTO books (id, user_id, title, type, file_path, cover_path, total_pages, page_manifest)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        """, (book_id, user_id, title, final_type, db_file_path, cover_url_path, final_total_pages, page_manifest_json))
        
        new_book = conn.execute("SELECT * FROM books WHERE id = ?;", (book_id,)).fetchone()
        
    return new_book

from fastapi import Header

async def handle_binary_stream(book_id: str, user_id: str, range: Optional[str] = None):
    with get_db() as conn:
        book = conn.execute(
            "SELECT * FROM books WHERE id = ? AND user_id = ?;",
            (book_id, user_id)
        ).fetchone()
        
    if not book:
        raise HTTPException(status_code=404, detail="Book not found or access denied")
        
    book_type = book.get("type") or book.get("file_type")
    if not book_type:
        raise HTTPException(status_code=400, detail="Invalid or missing book type")
        
    if book_type == "epub":
        media_type = "application/epub+zip"
    elif book_type == "pdf":
        media_type = "application/pdf"
    else:
        media_type = "application/zip"
        
    file_path = get_storage_path(book_id, book_type)
    
    try:
        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="Book file missing on server")
        file_size = os.path.getsize(file_path)
    except OSError as e:
        raise HTTPException(
            status_code=503,
            detail=f"Storage system is temporarily unavailable: {str(e)}"
        )
        
    start = 0
    end = file_size - 1
    status_code = 200
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": f"inline; filename=\"{book['title']}.{book_type}\""
    }
    
    if range:
        match = re.match(r"bytes=(\d+)-(\d*)", range)
        if match:
            start = int(match.group(1))
            if match.group(2):
                end = int(match.group(2))
                
            if start >= file_size:
                return JSONResponse(
                    status_code=416,
                    content={"detail": "Requested Range Not Satisfiable"},
                    headers={"Content-Range": f"bytes */{file_size}"}
                )
                
            end = min(end, file_size - 1)
            status_code = 206
            headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
            
    content_length = end - start + 1
    headers["Content-Length"] = str(content_length)
    
    def file_sender():
        try:
            with open(file_path, "rb") as f:
                f.seek(start)
                bytes_left = content_length
                chunk_size = 1024 * 64
                while bytes_left > 0:
                    read_size = min(chunk_size, bytes_left)
                    chunk = f.read(read_size)
                    if not chunk:
                        break
                    bytes_left -= len(chunk)
                    yield chunk
        except OSError as e:
            print(f"NFS Connection error while streaming {file_path}: {e}")
            return
            
    return StreamingResponse(file_sender(), status_code=status_code, media_type=media_type, headers=headers)

@app.get("/api/books/{book_id}/stream")
@app.get("/books/{book_id}/stream")
async def stream_book(
    book_id: str,
    range: Optional[str] = Header(None),
    user_id: str = Depends(get_current_user_id)
):
    return await handle_binary_stream(book_id, user_id, range)

@app.get("/api/books/{book_id}/file")
async def get_book_file(
    book_id: str,
    range: Optional[str] = Header(None),
    user_id: str = Depends(get_current_user_id)
):
    """
    Streams the book file directly to the client with seeking/range support.
    """
    return await handle_binary_stream(book_id, user_id, range)

@app.put("/api/books/{book_id}/progress")
async def update_progress(
    book_id: str,
    update: ProgressUpdateRequest,
    user_id: str = Depends(get_current_user_id)
):
    """
    Updates the active page, zoom level, and reading layout properties for a book.
    """
    with get_db() as conn:
        # Check ownership
        book = conn.execute(
            "SELECT id FROM books WHERE id = ? AND user_id = ?;",
            (book_id, user_id)
        ).fetchone()
        
        if not book:
            raise HTTPException(status_code=404, detail="Book not found or access denied")
            
        conn.execute("""
            UPDATE books
            SET current_page = ?,
                zoom = ?,
                view_mode = ?,
                scroll_position = ?,
                reading_direction = ?,
                last_read_at = datetime('now')
            WHERE id = ? AND user_id = ?;
        """, (
            update.current_page,
            update.zoom,
            update.view_mode,
            update.scroll_position,
            update.reading_direction,
            book_id,
            user_id
        ))
        
        updated_book = conn.execute("SELECT * FROM books WHERE id = ?;", (book_id,)).fetchone()
        
    return updated_book

@app.delete("/api/books/{book_id}")
async def delete_book(book_id: str, user_id: str = Depends(get_current_user_id)):
    """
    Deletes a book, removing it from the SQLite database and deleting its files from NFS storage.
    """
    with get_db() as conn:
        book = conn.execute(
            "SELECT * FROM books WHERE id = ? AND user_id = ?;",
            (book_id, user_id)
        ).fetchone()
        
        if not book:
            raise HTTPException(status_code=404, detail="Book not found or access denied")
            
        # Delete from DB
        conn.execute("DELETE FROM books WHERE id = ?;", (book_id,))
        
    # Delete file from storage
    delete_book_files_from_storage(book_id, book["type"])
        
    # Delete cover from disk
    if book["cover_path"]:
        cover_filename = os.path.basename(book["cover_path"])
        cover_path = os.path.join(COVERS_DIR, cover_filename)
        if os.path.exists(cover_path):
            os.remove(cover_path)
            
    return {"status": "success", "message": "Book deleted successfully"}

@app.post("/api/books/{book_id}/convert")
async def convert_existing_book(book_id: str, user_id: str = Depends(get_current_user_id)):
    """
    Converts an existing PDF book in the user's library to EPUB format.
    """
    with get_db() as conn:
        book = conn.execute(
            "SELECT * FROM books WHERE id = ? AND user_id = ?;",
            (book_id, user_id)
        ).fetchone()
        
    if not book:
        raise HTTPException(status_code=404, detail="Book not found or access denied")
        
    if book["type"] != "pdf":
        raise HTTPException(status_code=400, detail="Only PDF books can be converted to EPUB format.")
        
    pdf_path = get_storage_path(book_id, "pdf")
    if not os.path.exists(pdf_path):
        raise HTTPException(status_code=404, detail="Original PDF file is missing on the server")
        
    try:
        # Read PDF bytes (no longer gzipped on NFS)
        with open(pdf_path, "rb") as f:
            pdf_bytes = f.read()
            
        # Convert PDF to EPUB
        from app.epub_converter import convert_pdf_to_epub
        epub_bytes = convert_pdf_to_epub(pdf_bytes, book["title"])
        
        # Save EPUB to correct destination
        epub_path = get_storage_path(book_id, "epub")
        os.makedirs(os.path.dirname(epub_path), exist_ok=True)
        with open(epub_path, "wb") as f:
            f.write(epub_bytes)
            
        # Remove old PDF file
        try:
            os.remove(pdf_path)
        except OSError as e:
            print(f"Warning: Failed to delete converted PDF: {e}")
            
        # Update type and file_path in DB
        with get_db() as conn:
            conn.execute("""
                UPDATE books
                SET type = 'epub',
                    file_path = ?,
                    last_read_at = datetime('now')
                WHERE id = ? AND user_id = ?;
            """, (f"binaries/epubs/{book_id}.epub", book_id, user_id))
            
            updated_book = conn.execute("SELECT * FROM books WHERE id = ?;", (book_id,)).fetchone()
            
        return updated_book
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Conversion failed: {str(e)}")

class MediaTokenResponse(BaseModel):
    token: str

@app.post("/api/books/{book_id}/media-token", response_model=MediaTokenResponse)
async def get_book_media_token(book_id: str, user_id: str = Depends(get_current_user_id)):
    """
    Generates a short-lived signed media token for accessing images/pages of the book.
    """
    with get_db() as conn:
        book = conn.execute(
            "SELECT * FROM books WHERE id = ? AND user_id = ?;",
            (book_id, user_id)
        ).fetchone()
        
    if not book:
        raise HTTPException(status_code=404, detail="Book not found or access denied")
        
    # Generate media token
    from app.auth import create_media_token
    token = create_media_token(user_id, book_id)
    return {"token": token}

@app.get("/api/books/{book_id}/manga/pages")
async def get_manga_pages(book_id: str, user_id: str = Depends(get_current_user_id)):
    """
    Returns the list of manga pages (cached manifest) for a ZIP/CBZ archive.
    Generates it lazily if missing.
    """
    with get_db() as conn:
        book = conn.execute(
            "SELECT * FROM books WHERE id = ? AND user_id = ?;",
            (book_id, user_id)
        ).fetchone()
        
    if not book:
        raise HTTPException(status_code=404, detail="Book not found or access denied")
        
    if book["type"] not in ["manga", "cbz", "zip"]:
        raise HTTPException(status_code=400, detail="Only manga books have page manifests")
        
    # Check if page manifest is already cached in DB
    if book["page_manifest"]:
        try:
            pages = json.loads(book["page_manifest"])
            return {"pages": pages}
        except Exception:
            pass
            
    # Lazy generation from legacy zip
    file_path = os.path.join(UPLOADS_DIR, book["file_path"])
    if not os.path.exists(file_path):
        file_path = os.path.join(LIBRARY_STORAGE_DIR, "manga", f"{book_id}.zip")
        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="Book file missing on server")
        
    try:
        import tempfile
        import shutil
        from PIL import Image
        
        tmp_base = tempfile.gettempdir()
        extract_dir = os.path.join(tmp_base, f"manga_extract_lazy_{book_id}")
        os.makedirs(extract_dir, exist_ok=True)
        
        with zipfile.ZipFile(file_path, "r") as z:
            z.extractall(extract_dir)
            
        image_files = []
        for root, dirs, files in os.walk(extract_dir):
            for file_entry in files:
                basename = os.path.basename(file_entry)
                if basename.startswith('.') or basename.lower() == 'thumbs.db':
                    continue
                ext = os.path.splitext(file_entry)[1].lower()
                if ext in ['.png', '.jpg', '.jpeg', '.webp', '.gif']:
                    full_path = os.path.join(root, file_entry)
                    rel_path = os.path.relpath(full_path, extract_dir)
                    image_files.append((rel_path, full_path))
                    
        image_files.sort(key=lambda x: natural_sort_key(x[0]))
        
        pages = []
        for rel_path, full_path in image_files:
            rel_path_norm = rel_path.replace(os.sep, '/')
            parts = rel_path_norm.split('/')
            chapter_id = "_".join(parts[:-1]) if len(parts) > 1 else "1"
            page_number = os.path.splitext(parts[-1])[0]
            
            chapter_id = sanitize_path_segment(chapter_id)
            page_number = sanitize_path_segment(page_number)
            
            nfs_manga_dir = os.path.join(LIBRARY_STORAGE_DIR, "manga", book_id, chapter_id)
            os.makedirs(nfs_manga_dir, exist_ok=True)
            dest_webp_path = os.path.join(nfs_manga_dir, f"{page_number}.webp")
            
            with Image.open(full_path) as img:
                img.save(dest_webp_path, "WEBP")
            pages.append(f"{chapter_id}/{page_number}.webp")
            
        # Update DB with manifest
        page_manifest_json = json.dumps(pages)
        with get_db() as conn:
            conn.execute("""
                UPDATE books
                SET page_manifest = ?,
                    total_pages = ?,
                    file_path = ?
                WHERE id = ?;
            """, (page_manifest_json, len(pages), f"manga/{book_id}", book_id))
            
        # Cleanup
        try:
            shutil.rmtree(extract_dir)
        except Exception:
            pass
            
        return {"pages": pages}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lazy manga extraction failed: {str(e)}")

@app.get("/api/books/{book_id}/manga/pages/{page_index}/image")
async def get_manga_page_image(
    book_id: str,
    page_index: int,
    token: str,
):
    """
    Streams a single page image directly from NFS manga directory.
    Validates the short-lived media token and book permissions.
    """
    # 1. Validate the short-lived media token
    from app.auth import verify_media_token
    user_id = verify_media_token(token, book_id)
    
    # 2. Verify book permissions
    with get_db() as conn:
        book = conn.execute(
            "SELECT * FROM books WHERE id = ? AND user_id = ?;",
            (book_id, user_id)
        ).fetchone()
        
    if not book:
        raise HTTPException(status_code=404, detail="Book not found or access denied")
        
    if book["type"] not in ["manga", "cbz", "zip"]:
        raise HTTPException(status_code=400, detail="Only manga books have image pages")
        
    # 3. Retrieve or lazily load the page manifest to find the filename at page_index
    pages = []
    if book["page_manifest"]:
        try:
            pages = json.loads(book["page_manifest"])
        except Exception:
            pass
            
    if not pages:
        # Fallback for legacy records that didn't have pages extracted
        file_path = os.path.join(UPLOADS_DIR, book["file_path"])
        if not os.path.exists(file_path):
            file_path = os.path.join(LIBRARY_STORAGE_DIR, "manga", f"{book_id}.zip")
            if not os.path.exists(file_path):
                raise HTTPException(status_code=404, detail="Book file missing")
                
        # Perform lazy extraction to NFS
        try:
            import tempfile
            import shutil
            from PIL import Image
            
            tmp_base = tempfile.gettempdir()
            extract_dir = os.path.join(tmp_base, f"manga_extract_lazy_{book_id}")
            os.makedirs(extract_dir, exist_ok=True)
            
            with zipfile.ZipFile(file_path, "r") as z:
                z.extractall(extract_dir)
                
            image_files = []
            for root, dirs, files in os.walk(extract_dir):
                for file_entry in files:
                    basename = os.path.basename(file_entry)
                    if basename.startswith('.') or basename.lower() == 'thumbs.db':
                        continue
                    ext = os.path.splitext(file_entry)[1].lower()
                    if ext in ['.png', '.jpg', '.jpeg', '.webp', '.gif']:
                        full_path = os.path.join(root, file_entry)
                        rel_path = os.path.relpath(full_path, extract_dir)
                        image_files.append((rel_path, full_path))
                        
            image_files.sort(key=lambda x: natural_sort_key(x[0]))
            
            pages = []
            for rel_path, full_path in image_files:
                rel_path_norm = rel_path.replace(os.sep, '/')
                parts = rel_path_norm.split('/')
                chapter_id = "_".join(parts[:-1]) if len(parts) > 1 else "1"
                page_number = os.path.splitext(parts[-1])[0]
                
                chapter_id = sanitize_path_segment(chapter_id)
                page_number = sanitize_path_segment(page_number)
                
                nfs_manga_dir = os.path.join(LIBRARY_STORAGE_DIR, "manga", book_id, chapter_id)
                os.makedirs(nfs_manga_dir, exist_ok=True)
                dest_webp_path = os.path.join(nfs_manga_dir, f"{page_number}.webp")
                
                with Image.open(full_path) as img:
                    img.save(dest_webp_path, "WEBP")
                pages.append(f"{chapter_id}/{page_number}.webp")
                
            # Update DB with manifest
            page_manifest_json = json.dumps(pages)
            with get_db() as conn:
                conn.execute("""
                    UPDATE books
                    SET page_manifest = ?,
                        total_pages = ?,
                        file_path = ?
                    WHERE id = ?;
                """, (page_manifest_json, len(pages), f"manga/{book_id}", book_id))
                
            # Cleanup
            try:
                shutil.rmtree(extract_dir)
            except Exception:
                pass
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Lazy manga extraction failed: {str(e)}")
            
    if page_index < 0 or page_index >= len(pages):
        raise HTTPException(status_code=404, detail="Page index out of bounds")
        
    target_filename = pages[page_index]
    webp_path = os.path.join(LIBRARY_STORAGE_DIR, "manga", book_id, target_filename)
    
    if not os.path.exists(webp_path):
        raise HTTPException(status_code=404, detail="Manga page image file missing on storage")
        
    # Stream the file directly from NFS
    from fastapi.responses import FileResponse
    try:
        return FileResponse(webp_path, media_type="image/webp")
    except OSError as e:
        raise HTTPException(
            status_code=503,
            detail=f"Storage system is temporarily unavailable: {str(e)}"
        )

# Mount frontend compiled static files (if they exist)
STATIC_DIR = os.path.join(BASE_DIR, "static")
if os.path.exists(STATIC_DIR):
    from fastapi.responses import FileResponse
    
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

    # Fallback to index.html for React client-side routing
    @app.exception_handler(404)
    async def spa_fallback(request, exc):
        if request.url.path.startswith("/api"):
            return JSONResponse(status_code=404, content={"detail": "API endpoint not found"})
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))

