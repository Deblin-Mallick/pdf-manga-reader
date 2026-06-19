import sqlite3
import os
import time
from contextlib import contextmanager

from app.secrets import load_gcp_secrets
load_gcp_secrets()

# Read database URL (default fallback to SQLite)
DATABASE_URL = os.environ.get("DATABASE_URL", "")

IS_POSTGRES = DATABASE_URL.startswith("postgresql://") or DATABASE_URL.startswith("postgres://")

psycopg2 = None
RealDictCursor = None

if IS_POSTGRES:
    import psycopg2
    from psycopg2.extras import RealDictCursor

class PgCursor:
    def __init__(self, pg_cursor):
        self.cursor = pg_cursor

    def execute(self, query, params=None):
        # Translate SQL standard query parameters for PostgreSQL
        adapted_query = query.replace('?', '%s')
        # Translate SQLite time function
        adapted_query = adapted_query.replace("datetime('now')", "CURRENT_TIMESTAMP")
        self.cursor.execute(adapted_query, params)
        return self

    def fetchone(self):
        row = self.cursor.fetchone()
        if row is not None:
            return dict(row)
        return None

    def fetchall(self):
        rows = self.cursor.fetchall()
        return [dict(r) for r in rows]

    def __iter__(self):
        return self

    def __next__(self):
        row = self.cursor.fetchone()
        if row is None:
            raise StopIteration
        return dict(row)

class PgConnection:
    def __init__(self, pg_conn):
        self.conn = pg_conn

    def execute(self, query, params=None):
        cursor = self.conn.cursor(cursor_factory=RealDictCursor)
        wrapped_cursor = PgCursor(cursor)
        wrapped_cursor.execute(query, params)
        return wrapped_cursor

    def commit(self):
        self.conn.commit()

    def rollback(self):
        self.conn.rollback()

    def close(self):
        self.conn.close()

DB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DB_PATH = os.path.join(DB_DIR, "reader.db")

def dict_factory(cursor, row):
    d = {}
    for idx, col in enumerate(cursor.description):
        d[col[0]] = row[idx]
    return d

@contextmanager
def get_db():
    if IS_POSTGRES:
        conn = psycopg2.connect(DATABASE_URL)  # type: ignore
        wrapped_conn = PgConnection(conn)
        try:
            yield wrapped_conn
            wrapped_conn.commit()
        except Exception as e:
            wrapped_conn.rollback()
            raise e
        finally:
            wrapped_conn.close()
    else:
        # Ensure SQLite database folder exists
        os.makedirs(DB_DIR, exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = dict_factory
        conn.execute("PRAGMA foreign_keys = ON;")
        try:
            conn.execute("PRAGMA journal_mode = WAL;")
        except Exception:
            pass
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        conn.execute("PRAGMA temp_store = MEMORY;")
        try:
            yield conn
            conn.commit()
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.close()

def init_db():
    retries = 5
    delay = 2
    for i in range(retries):
        try:
            with get_db() as conn:
                # Create users table
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS users (
                        id TEXT PRIMARY KEY,
                        email TEXT,
                        name TEXT,
                        picture TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
                        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        last_read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
                    INSERT INTO users (id, email, name, picture)
                    VALUES ('guest', 'guest@local.dev', 'Guest Reader', '')
                    ON CONFLICT(id) DO NOTHING;
                """)
            print("Database initialized successfully.")
            break
        except Exception as e:
            if i == retries - 1:
                print(f"Database initialization failed after {retries} retries.")
                raise e
            print(f"Database connection not ready yet: {e}. Retrying in {delay} seconds...")
            time.sleep(delay)
            delay *= 2
