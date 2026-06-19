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
from app.compression import compress_and_save, decompress_and_stream

# Setup directories relative to the backend root
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
COVERS_DIR = os.path.join(BASE_DIR, "covers")

os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(COVERS_DIR, exist_ok=True)

import datetime

def cleanup_expired_guests():
    try:
        # Expire guest sessions older than 12 hours of inactivity
        threshold = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=12)
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

# Mount covers folder to serve cover images statically
app.mount("/covers", StaticFiles(directory=COVERS_DIR), name="covers")

class GoogleLoginRequest(BaseModel):
    id_token: str

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
    """
    try:
        user_info = verify_google_token(req.id_token)
        user_id = user_info["id"]
        
        # Save or update user in SQLite
        with get_db() as conn:
            conn.execute("""
                INSERT INTO users (id, email, name, picture)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    email=excluded.email,
                    name=excluded.name,
                    picture=excluded.picture;
            """, (user_id, user_info["email"], user_info["name"], user_info["picture"]))
            
        # Create backend JWT session token
        session_token = create_session_token(user_id)
        
        return {
            "token": session_token,
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
    Uploads a new book/manga. Files are compressed to .gz on disk.
    Covers are saved in covers/ directory.
    """
    book_id = str(uuid.uuid4())
    
    # 1. Compress and save file data to uploads/
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

    file_name = f"{book_id}.gz"
    file_path = os.path.join(UPLOADS_DIR, file_name)
    compress_and_save(final_file_bytes, file_path)
    
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
            INSERT INTO books (id, user_id, title, type, file_path, cover_path, total_pages)
            VALUES (?, ?, ?, ?, ?, ?, ?);
        """, (book_id, user_id, title, final_type, file_name, cover_url_path, final_total_pages))
        
        new_book = conn.execute("SELECT * FROM books WHERE id = ?;", (book_id,)).fetchone()
        
    return new_book

@app.get("/api/books/{book_id}/file")
async def get_book_file(book_id: str, user_id: str = Depends(get_current_user_id)):
    """
    Streams the decompressed book file directly to the client.
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
    
    return StreamingResponse(
        decompress_and_stream(file_path),
        media_type=media_type,
        headers={"Content-Disposition": f"inline; filename={book['title']}.{book['type']}"}
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
        # Read and decompress gzipped PDF
        pdf_bytes = b"".join(decompress_and_stream(file_path))
        
        # Convert PDF to EPUB
        from app.epub_converter import convert_pdf_to_epub
        epub_bytes = convert_pdf_to_epub(pdf_bytes, book["title"])
        
        # Overwrite the file on disk with the compressed EPUB bytes
        compress_and_save(epub_bytes, file_path)
        
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

