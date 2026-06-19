import io
import os
import pytest
from app.auth import create_session_token

def test_get_auth_config(client):
    response = client.get("/api/auth/config")
    assert response.status_code == 200
    assert "google_client_id" in response.json()

def test_get_me_guest(client):
    response = client.get("/api/auth/me")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "guest"
    assert data["name"] == "Guest Reader"

def test_get_me_not_found(client):
    token = create_session_token("nonexistent-id")
    response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 404

def test_google_auth_success(client, monkeypatch):
    def mock_verify(token):
        return {
            "id": "google-user-123",
            "email": "user@google.com",
            "name": "Google User",
            "picture": "http://pic.jpg"
        }
    monkeypatch.setattr("app.main.verify_google_token", mock_verify)
    
    response = client.post("/api/auth/google", json={"id_token": "valid-token"})
    assert response.status_code == 200
    data = response.json()
    assert "token" in data
    assert data["user"]["id"] == "google-user-123"
    assert data["user"]["email"] == "user@google.com"

def test_book_crud_lifecycle(client):
    from pypdf import PdfWriter
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    pdf_buf = io.BytesIO()
    writer.write(pdf_buf)
    pdf_bytes = pdf_buf.getvalue()
    
    token = "guest_temp_user"
    headers = {"Authorization": f"Bearer {token}"}
    
    # 1. Upload Book
    files = {
        "file": ("test_manga.pdf", pdf_bytes, "application/pdf"),
        "cover": ("cover.jpg", b"fake-cover-bytes", "image/jpeg")
    }
    data = {
        "title": "My Test PDF Book",
        "type": "pdf",
        "total_pages": 1,
        "convert_to_epub": "false"
    }
    
    response = client.post("/api/books", headers=headers, data=data, files=files)
    assert response.status_code == 200
    book = response.json()
    assert book["title"] == "My Test PDF Book"
    assert book["type"] == "pdf"
    book_id = book["id"]
    
    # Verify files on disk
    import app.main
    uploads_dir = app.main.UPLOADS_DIR
    covers_dir = app.main.COVERS_DIR
    assert os.path.exists(os.path.join(uploads_dir, f"{book_id}.gz"))
    assert os.path.exists(os.path.join(covers_dir, f"{book_id}.jpg"))
    
    # 2. Get Books
    response = client.get("/api/books", headers=headers)
    assert response.status_code == 200
    books = response.json()
    assert len(books) == 1
    assert books[0]["id"] == book_id
    
    # 3. Stream Book File
    response = client.get(f"/api/books/{book_id}/file", headers=headers)
    assert response.status_code == 200
    assert response.content == pdf_bytes
    
    # 4. Update Progress
    progress_payload = {
        "current_page": 5,
        "zoom": 1.5,
        "view_mode": "fit-height",
        "scroll_position": 250,
        "reading_direction": "rtl"
    }
    response = client.put(f"/api/books/{book_id}/progress", headers=headers, json=progress_payload)
    assert response.status_code == 200
    updated_book = response.json()
    assert updated_book["current_page"] == 5
    assert updated_book["zoom"] == 1.5
    
    # 5. Convert to EPUB
    response = client.post(f"/api/books/{book_id}/convert", headers=headers)
    assert response.status_code == 200
    converted_book = response.json()
    assert converted_book["type"] == "epub"
    
    # Verify stream now returns EPUB type
    response = client.get(f"/api/books/{book_id}/file", headers=headers)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/epub+zip"
    
    # 6. Delete Book
    response = client.delete(f"/api/books/{book_id}", headers=headers)
    assert response.status_code == 200
    
    # Verify files deleted from disk
    assert not os.path.exists(os.path.join(uploads_dir, f"{book_id}.gz"))
    assert not os.path.exists(os.path.join(covers_dir, f"{book_id}.jpg"))
    
    # Verify deleted from DB
    response = client.get("/api/books", headers=headers)
    assert response.status_code == 200
    assert len(response.json()) == 0

def test_guest_logout_purges_data(client):
    token = "guest_logout_user"
    headers = {"Authorization": f"Bearer {token}"}
    
    from pypdf import PdfWriter
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    pdf_buf = io.BytesIO()
    writer.write(pdf_buf)
    
    files = {"file": ("guest.pdf", pdf_buf.getvalue(), "application/pdf")}
    data = {"title": "Guest Book", "type": "pdf", "total_pages": 1, "convert_to_epub": "false"}
    
    response = client.post("/api/books", headers=headers, data=data, files=files)
    book_id = response.json()["id"]
    
    import app.main
    assert os.path.exists(os.path.join(app.main.UPLOADS_DIR, f"{book_id}.gz"))
    
    # Log out
    response = client.post("/api/auth/logout", headers=headers)
    assert response.status_code == 200
    
    # Verify files and DB entries are purged
    assert not os.path.exists(os.path.join(app.main.UPLOADS_DIR, f"{book_id}.gz"))
    
    from app.db import get_db
    with get_db() as conn:
        book_rec = conn.execute("SELECT * FROM books WHERE id = ?;", (book_id,)).fetchone()
        user_rec = conn.execute("SELECT * FROM users WHERE id = ?;", (token,)).fetchone()
        assert book_rec is None
        assert user_rec is None
