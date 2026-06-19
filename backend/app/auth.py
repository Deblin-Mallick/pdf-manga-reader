import os
import time
import requests
import jwt
from fastapi import Header, HTTPException, status, Depends
from typing import Optional

def load_env_file():
    # Try to find .env file in parent directories
    # auth.py is in backend/app/auth.py
    app_dir = os.path.dirname(os.path.abspath(__file__))
    backend_dir = os.path.dirname(app_dir)
    root_dir = os.path.dirname(backend_dir)
    
    env_paths = [
        os.path.join(root_dir, ".env"),
        os.path.join(backend_dir, ".env"),
        os.path.join(app_dir, ".env"),
    ]
    for path in env_paths:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            key, val = line.split("=", 1)
                            key = key.strip()
                            val = val.strip().strip("'\"")
                            if key not in os.environ:
                                os.environ[key] = val
                break
            except Exception as e:
                print(f"Error loading env from {path}: {e}")

load_env_file()

from app.secrets import load_gcp_secrets
load_gcp_secrets()

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "development")

JWT_SECRET = os.environ.get("JWT_SECRET", "")
if not JWT_SECRET:
    if ENVIRONMENT == "production":
        raise ValueError(
            "CRITICAL SECURITY ERROR: JWT_SECRET environment variable must be set in production! "
            "Please generate a secure random string and assign it to JWT_SECRET."
        )
    JWT_SECRET = "super-secret-manga-reader-token-key-2026"

JWT_ALGORITHM = "HS256"
JWT_EXPIRY_SECONDS = 30 * 24 * 60 * 60  # 30 days session expiry

def verify_google_token(id_token: str) -> dict:
    """
    Verifies a Google ID Token using Google's tokeninfo API endpoint.
    Returns the user data dict if valid, raises HTTPException otherwise.
    """
    try:
        response = requests.get(
            f"https://oauth2.googleapis.com/tokeninfo?id_token={id_token}",
            timeout=10
        )
        if response.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Google OAuth token"
            )
        
        payload = response.json()
        
        # Verify audience is our client ID (if configured)
        if GOOGLE_CLIENT_ID and payload.get("aud") != GOOGLE_CLIENT_ID:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token audience mismatch"
            )
            
        return {
            "id": payload["sub"],
            "email": payload.get("email"),
            "name": payload.get("name"),
            "picture": payload.get("picture", "")
        }
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Google token validation failed: {str(e)}"
        )

def create_session_token(user_id: str) -> str:
    """
    Generates a local JWT session token for the user.
    """
    payload = {
        "sub": user_id,
        "iat": int(time.time()),
        "exp": int(time.time()) + JWT_EXPIRY_SECONDS
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def get_current_user_id(authorization: Optional[str] = Header(None)) -> str:
    """
    FastAPI dependency to extract and authenticate the current user from the Authorization header.
    Falls back to 'guest' if token is absent or invalid.
    """
    if not authorization:
        return "guest"
        
    try:
        parts = authorization.split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return "guest"
            
        token = parts[1]
        if token.startswith("guest_"):
            # Ensure guest user exists in DB to prevent foreign key violations on books table
            from app.db import get_db
            try:
                with get_db() as conn:
                    conn.execute("""
                        INSERT INTO users (id, email, name, picture)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(id) DO NOTHING;
                    """, (token, "guest@local.dev", "Guest Reader", ""))
            except Exception as db_err:
                print(f"Error ensuring guest user exists in database: {db_err}")
            return token
            
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload["sub"]
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        # We don't crash, we fall back to guest or raise an error depending on strictness.
        return "guest"

MEDIA_TOKEN_EXPIRY_SECONDS = 300  # 5 minutes

def create_media_token(user_id: str, book_id: str) -> str:
    """
    Generates a short-lived signed media token for streaming images/media of a specific book.
    """
    payload = {
        "sub": user_id,
        "book_id": book_id,
        "type": "media",
        "iat": int(time.time()),
        "exp": int(time.time()) + MEDIA_TOKEN_EXPIRY_SECONDS
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def verify_media_token(token: str, book_id: str) -> str:
    """
    Verifies a short-lived media token for a specific book.
    Returns the user_id if valid, raises HTTPException otherwise.
    """
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "media":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token type for media access"
            )
        if payload.get("book_id") != book_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token is not valid for this book"
            )
        return payload["sub"]
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Media token has expired"
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid media token"
        )

