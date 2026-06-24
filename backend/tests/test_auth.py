import jwt
import pytest
import app.auth
from app.auth import create_session_token, get_current_user_id

def test_create_session_token():
    user_id = "test-user-123"
    token = create_session_token(user_id)
    
    # Decode token to verify using the patched module-level constants
    payload = jwt.decode(token, app.auth.JWT_SECRET, algorithms=[app.auth.JWT_ALGORITHM])
    assert payload["sub"] == user_id
    assert "iat" in payload
    assert "exp" in payload

def test_get_current_user_id_missing_header():
    assert get_current_user_id(None) == "guest"

def test_get_current_user_id_invalid_format():
    assert get_current_user_id("InvalidHeaderVal") == "guest"
    assert get_current_user_id("Bearer") == "guest"
    assert get_current_user_id("Basic token123") == "guest"

def test_get_current_user_id_guest_token():
    guest_token = "guest_abc123"
    ret_val = get_current_user_id(f"Bearer {guest_token}")
    assert ret_val == guest_token
    
    # Check that guest user was indeed inserted into database
    from app.db import get_db
    with get_db() as conn:
        user = conn.execute("SELECT * FROM users WHERE id = ?;", (guest_token,)).fetchone()
        assert user is not None
        assert user["name"] == "Guest Reader"

def test_get_current_user_id_valid_jwt():
    user_id = "authenticated-user-999"
    token = create_session_token(user_id)
    ret_val = get_current_user_id(f"Bearer {token}")
    assert ret_val == user_id

def test_get_current_user_id_expired_or_invalid_jwt():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        get_current_user_id("Bearer invalid.jwt.token")
    assert exc_info.value.status_code == 401
