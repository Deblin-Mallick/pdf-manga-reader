import sqlite3
import os
from contextlib import contextmanager

DB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DB_PATH = os.path.join(DB_DIR, "reader.db")

def dict_factory(cursor, row):
    d = {}
    for idx, col in enumerate(cursor.description):
        d[col[0]] = row[idx]
    return d

@contextmanager
def get_db():
    # Ensure database folder exists
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = dict_factory
    conn.execute("PRAGMA foreign_keys = ON;")
    try:
        yield conn
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()

def init_db():
    with get_db() as conn:
        # Create users table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT,
                name TEXT,
                picture TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
        """)
        
        # Create books table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS books (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                title TEXT NOT NULL,
                type TEXT NOT NULL,
                file_path TEXT NOT NULL,
                cover_path TEXT,
                added_at TEXT DEFAULT (datetime('now')),
                last_read_at TEXT DEFAULT (datetime('now')),
                current_page INTEGER DEFAULT 1,
                total_pages INTEGER DEFAULT 1,
                zoom REAL DEFAULT 1.0,
                view_mode TEXT DEFAULT 'fit-width',
                scroll_position INTEGER DEFAULT 0,
                reading_direction TEXT DEFAULT 'ltr',
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        """)
        
        # Ensure a default 'guest' user exists in case login is bypassed
        conn.execute("""
            INSERT OR IGNORE INTO users (id, email, name, picture)
            VALUES ('guest', 'guest@local.dev', 'Guest Reader', '');
        """)
