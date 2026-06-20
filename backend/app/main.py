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



# Setup directories relative to the backend root
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
COVERS_DIR = os.path.join(BASE_DIR, "covers")

os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(COVERS_DIR, exist_ok=True)

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
                SELECT id, file_path, cover_path FROM books 
                WHERE user_id LIKE 'guest_%' AND last_read_at < ?;
            """, (threshold,)).fetchall()
            
            deleted_count = 0
            for book in books:
                file_path = os.path.join(UPLOADS_DIR, book["file_path"])
                if os.path.exists(file_path):
                    os.remove(file_path)
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
                    "SELECT id, file_path, cover_path FROM books WHERE user_id = ?;", 
                    (user_id,)
                ).fetchall()
                
                for book in books:
                    file_path = os.path.join(UPLOADS_DIR, book["file_path"])
                    if os.path.exists(file_path):
                        os.remove(file_path)
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
    Uploads a new book/manga. Files are stored in native raw format on disk.
    Covers are saved in covers/ directory.
    """
    book_id = str(uuid.uuid4())
    
    # 1. Read file bytes
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

    # Get extension from filename
    ext = os.path.splitext(file.filename)[1].lower() if file.filename else ""
    if not ext:
        if final_type == "pdf":
            ext = ".pdf"
        elif final_type == "epub":
            ext = ".epub"
        else:
            ext = ".zip"
            
    file_name = f"{book_id}{ext}"
    file_path = os.path.join(UPLOADS_DIR, file_name)
    
    # Save raw file bytes
    with open(file_path, "wb") as f:
        f.write(final_file_bytes)
        
    # Generate page manifest for manga (ZIP/CBZ) files
    page_manifest_json = None
    if final_type in ["manga", "cbz", "zip"]:
        import io
        pages = get_manga_pages_from_zip(io.BytesIO(final_file_bytes))
        final_total_pages = len(pages)
        page_manifest_json = json.dumps(pages)
    
    # 2. Save cover image to covers/ if provided
    cover_url_path = ""
    if cover:
        cover_bytes = await cover.read()
        cover_name = f"{book_id}.jpg"
        cover_path = os.path.join(COVERS_DIR, cover_name)
        with open(cover_path, "wb") as f:
            f.write(cover_bytes)
        cover_url_path = f"/covers/{cover_name}"
        
    # 3. Save to database
    with get_db() as conn:
        conn.execute("""
            INSERT INTO books (id, user_id, title, type, file_path, cover_path, total_pages, page_manifest)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        """, (book_id, user_id, title, final_type, file_name, cover_url_path, final_total_pages, page_manifest_json))
        
        new_book = conn.execute("SELECT * FROM books WHERE id = ?;", (book_id,)).fetchone()
        
    return new_book

@app.get("/api/books/{book_id}/file")
async def get_book_file(book_id: str, user_id: str = Depends(get_current_user_id)):
    """
    Streams the book file directly to the client.
    """
    with get_db() as conn:
        book = conn.execute(
            "SELECT * FROM books WHERE id = ? AND user_id = ?;",
            (book_id, user_id)
        ).fetchone()
        
    if not book:
        raise HTTPException(status_code=404, detail="Book not found or access denied")
        
    file_path = os.path.join(UPLOADS_DIR, book["file_path"])
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Book file missing on server")
        
    # Set headers based on format type
    if book["type"] == "pdf":
        media_type = "application/pdf"
    elif book["type"] == "epub":
        media_type = "application/epub+zip"
    else:
        media_type = "application/zip"
    
    if is_gzip_file(file_path):
        return StreamingResponse(
            decompress_and_stream(file_path),
            media_type=media_type,
            headers={"Content-Disposition": f"inline; filename={book['title']}.{book['type']}"}
        )
    else:
        from fastapi.responses import FileResponse
        return FileResponse(
            file_path,
            media_type=media_type,
            filename=f"{book['title']}.{book['type']}"
        )

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
    Deletes a book, removing it from the SQLite database and deleting its files from disk.
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
        
    # Delete file from disk
    file_path = os.path.join(UPLOADS_DIR, book["file_path"])
    if os.path.exists(file_path):
        os.remove(file_path)
        
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
        
    file_path = os.path.join(UPLOADS_DIR, book["file_path"])
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Original PDF file is missing on the server")
        
    try:
        # Read PDF bytes, decompressing if gzipped
        if is_gzip_file(file_path):
            pdf_bytes = b"".join(decompress_and_stream(file_path))
            # Convert PDF to EPUB
            from app.epub_converter import convert_pdf_to_epub
            epub_bytes = convert_pdf_to_epub(pdf_bytes, book["title"])
            # Overwrite legacy file with compressed EPUB
            compress_and_save(epub_bytes, file_path)
        else:
            with open(file_path, "rb") as f:
                pdf_bytes = f.read()
            # Convert PDF to EPUB
            from app.epub_converter import convert_pdf_to_epub
            epub_bytes = convert_pdf_to_epub(pdf_bytes, book["title"])
            # Save raw EPUB
            with open(file_path, "wb") as f:
                f.write(epub_bytes)
        
        # Update type to 'epub' in DB
        with get_db() as conn:
            conn.execute("""
                UPDATE books
                SET type = 'epub',
                    last_read_at = datetime('now')
                WHERE id = ? AND user_id = ?;
            """, (book_id, user_id))
            
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
            
    # Lazy generation
    file_path = os.path.join(UPLOADS_DIR, book["file_path"])
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Book file missing on server")
        
    pages = []
    if is_gzip_file(file_path):
        try:
            with gzip.open(file_path, "rb") as gf:
                zip_data = gf.read()
            import io
            pages = get_manga_pages_from_zip(io.BytesIO(zip_data))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to read legacy archive: {str(e)}")
    else:
        pages = get_manga_pages_from_zip(file_path)
        
    # Persist the generated page manifest to DB
    page_count = len(pages)
    page_manifest_json = json.dumps(pages)
    
    with get_db() as conn:
        conn.execute("""
            UPDATE books
            SET page_manifest = ?,
                total_pages = ?
            WHERE id = ?;
        """, (page_manifest_json, page_count, book_id))
        
    return {"pages": pages}

@app.get("/api/books/{book_id}/manga/pages/{page_index}/image")
async def get_manga_page_image(
    book_id: str,
    page_index: int,
    token: str,
):
    """
    Streams a single page image directly from the archive.
    Validates the short-lived media token and book permissions.
    """
    # 1. Validate the short-lived media token
    from app.auth import verify_media_token
    user_id = verify_media_token(token, book_id)
    
    # 2. Verify book permissions (make sure user owns/has access to the book)
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
        file_path = os.path.join(UPLOADS_DIR, book["file_path"])
        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="Book file missing")
            
        if is_gzip_file(file_path):
            try:
                with gzip.open(file_path, "rb") as gf:
                    zip_data = gf.read()
                import io
                pages = get_manga_pages_from_zip(io.BytesIO(zip_data))
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Failed to read legacy archive: {str(e)}")
        else:
            pages = get_manga_pages_from_zip(file_path)
            
        page_manifest_json = json.dumps(pages)
        with get_db() as conn:
            conn.execute("""
                UPDATE books
                SET page_manifest = ?,
                    total_pages = ?
                WHERE id = ?;
            """, (page_manifest_json, len(pages), book_id))
            
    if page_index < 0 or page_index >= len(pages):
        raise HTTPException(status_code=404, detail="Page index out of bounds")
        
    target_filename = pages[page_index]
    
    # 4. Stream directly from ZIP archive without extracting to disk
    file_path = os.path.join(UPLOADS_DIR, book["file_path"])
    
    # Determine content-type
    ext = os.path.splitext(target_filename)[1].lower()
    if ext == ".png":
        media_type = "image/png"
    elif ext in [".jpg", ".jpeg"]:
        media_type = "image/jpeg"
    elif ext == ".webp":
        media_type = "image/webp"
    elif ext == ".gif":
        media_type = "image/gif"
    else:
        media_type = "application/octet-stream"
        
    if is_gzip_file(file_path):
        try:
            with gzip.open(file_path, "rb") as gf:
                zip_data = gf.read()
            import io
            z = zipfile.ZipFile(io.BytesIO(zip_data))
            def stream_bytes():
                try:
                    with z.open(target_filename) as img_file:
                        while True:
                            chunk = img_file.read(1024 * 64)
                            if not chunk:
                                break
                            yield chunk
                finally:
                    z.close()
            return StreamingResponse(stream_bytes(), media_type=media_type)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to read legacy archive: {str(e)}")
    else:
        try:
            z = zipfile.ZipFile(file_path)
            def stream_bytes():
                try:
                    with z.open(target_filename) as img_file:
                        while True:
                            chunk = img_file.read(1024 * 64)
                            if not chunk:
                                break
                            yield chunk
                finally:
                    z.close()
            return StreamingResponse(stream_bytes(), media_type=media_type)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to read archive: {str(e)}")

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

