"""
update_database.py

One-shot migration script. Adds the three legacy columns Origin's session
table grew over time: `last_accessed`, `is_important`, `message_count`. The
same checks are also done in `core/database.py:init_db` on every fresh
start, so this script is only needed if you're migrating an older hand-edited
DB before booting the modern app. The newer code-path uses SQLAlchemy
`check_column_exists` (from `sqlalchemy.inspect`) which works on both
SQLite and Postgres; the older `try/except "duplicate column name"` path
was less portable and has been removed.

Usage:
    python update_database.py
"""

import os
from sqlalchemy import create_engine, inspect, text
from database import DATABASE_URL, SessionLocal


def check_column_exists(engine, table_name, column_name):
    """Check if a column exists in a table."""
    inspector = inspect(engine)
    columns = inspector.get_columns(table_name)
    return any(col["name"] == column_name for col in columns)


def update_database():
    """Update the database schema and populate new columns."""
    engine = create_engine(DATABASE_URL)

    print(f"Updating database at: {DATABASE_URL}")

    db = SessionLocal()
    try:
        # Add last_accessed column if it doesn't exist
        if not check_column_exists(engine, "sessions", "last_accessed"):
            print("Adding last_accessed column...")
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE sessions ADD COLUMN last_accessed DATETIME"))
                conn.commit()
        else:
            print("last_accessed column already exists")

        # Add is_important column if it doesn't exist
        if not check_column_exists(engine, "sessions", "is_important"):
            print("Adding is_important column...")
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE sessions ADD COLUMN is_important BOOLEAN DEFAULT FALSE"))
                conn.commit()
        else:
            print("is_important column already exists")

        # Add message_count column if it doesn't exist
        if not check_column_exists(engine, "sessions", "message_count"):
            print("Adding message_count column...")
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE sessions ADD COLUMN message_count INTEGER DEFAULT 0"))
                conn.commit()
        else:
            print("message_count column already exists")

        # Populate last_accessed with created_at where NULL
        print("Populating last_accessed column...")
        with engine.connect() as conn:
            conn.execute(text(
                "UPDATE sessions SET last_accessed = created_at WHERE last_accessed IS NULL"
            ))
            conn.commit()

        # Populate is_important with FALSE where NULL
        print("Populating is_important column...")
        with engine.connect() as conn:
            conn.execute(text("UPDATE sessions SET is_important = 0 WHERE is_important IS NULL"))
            conn.commit()

        # Recalculate message_count from chat_messages
        print("Recalculating message_count...")
        with engine.connect() as conn:
            conn.execute(text("UPDATE sessions SET message_count = 0"))
            conn.execute(text(
                "UPDATE sessions SET message_count = ("
                "SELECT COUNT(*) FROM chat_messages "
                "WHERE chat_messages.session_id = sessions.id)"
            ))
            conn.commit()

        print("Database update completed successfully!")
    except Exception as e:
        print(f"Error updating database: {e}")
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    update_database()
