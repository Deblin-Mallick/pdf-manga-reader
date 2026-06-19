import os
import pytest
from fastapi.testclient import TestClient

@pytest.fixture(autouse=True)
def mock_db_and_paths(monkeypatch, tmp_path):
    # Setup isolated directories
    db_dir = tmp_path / "data"
    uploads_dir = tmp_path / "uploads"
    covers_dir = tmp_path / "covers"
    
    db_dir.mkdir(parents=True, exist_ok=True)
    uploads_dir.mkdir(parents=True, exist_ok=True)
    covers_dir.mkdir(parents=True, exist_ok=True)
    
    test_db_path = str(db_dir / "test_reader.db")
    
    # Monkeypatch app modules
    import app.db
    import app.main
    import app.auth
    
    monkeypatch.setattr(app.db, "DB_DIR", str(db_dir))
    monkeypatch.setattr(app.db, "DB_PATH", test_db_path)
    monkeypatch.setattr(app.db, "IS_POSTGRES", False)  # Force SQLite for test runs
    
    monkeypatch.setattr(app.main, "UPLOADS_DIR", str(uploads_dir))
    monkeypatch.setattr(app.main, "COVERS_DIR", str(covers_dir))
    
    # Force mock environment settings for consistent JWT tests
    monkeypatch.setenv("JWT_SECRET", "test-secret-key-12345")
    monkeypatch.setattr(app.auth, "JWT_SECRET", "test-secret-key-12345")
    monkeypatch.setattr(app.auth, "GOOGLE_CLIENT_ID", "test-client-id")
    
    # Initialize the test database schema
    from app.db import init_db
    init_db()
    
    yield

@pytest.fixture
def client():
    from app.main import app
    with TestClient(app) as test_client:
        yield test_client
