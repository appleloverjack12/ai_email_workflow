"""
migrate_v2.py — one-time migration for ai_email_workflow

Adds:
  • quoteproposal.quote_status   (TEXT DEFAULT 'draft')
  • quoteproposal.sent_at        (DATETIME)
  • quoteproposal.responded_at   (DATETIME)
  • replytemplate table          (new table for saved reply templates)

Safe to run multiple times — skips columns that already exist.

Usage:
    python migrate_v2.py
    python migrate_v2.py --db /path/to/other/workflow.db
"""
import sqlite3
import sys
from pathlib import Path


def migrate(db_path: str = "workflow.db") -> None:
    if not Path(db_path).exists():
        print(f"No database found at '{db_path}'.")
        print("This is fine if you haven't started the app yet — "
              "tables will be created fresh on first startup.")
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # ── 1. New columns on quoteproposal ──────────────────────────────────────
    new_columns = [
        ("ALTER TABLE quoteproposal ADD COLUMN quote_status TEXT DEFAULT 'draft'",
         "quoteproposal.quote_status"),
        ("ALTER TABLE quoteproposal ADD COLUMN sent_at DATETIME",
         "quoteproposal.sent_at"),
        ("ALTER TABLE quoteproposal ADD COLUMN responded_at DATETIME",
         "quoteproposal.responded_at"),
    ]

    for sql, label in new_columns:
        try:
            cursor.execute(sql)
            print(f"  ADDED   {label}")
        except sqlite3.OperationalError as exc:
            msg = str(exc).lower()
            if "duplicate column" in msg or "already exists" in msg:
                print(f"  SKIP    {label}  (already exists)")
            else:
                conn.close()
                raise

    # ── 2. replytemplate table ────────────────────────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS replytemplate (
            id          INTEGER  PRIMARY KEY AUTOINCREMENT,
            name        TEXT     NOT NULL,
            category    TEXT,
            service_type TEXT,
            body_text   TEXT     NOT NULL,
            use_count   INTEGER  DEFAULT 0,
            created_by  TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    print("  READY   replytemplate table")

    conn.commit()
    conn.close()
    print("\nMigration complete. Restart the FastAPI server now.")


if __name__ == "__main__":
    db = "workflow.db"
    for arg in sys.argv[1:]:
        if arg.startswith("--db"):
            parts = arg.split("=", 1)
            if len(parts) == 2:
                db = parts[1]
            elif len(sys.argv) > sys.argv.index(arg) + 1:
                db = sys.argv[sys.argv.index(arg) + 1]
    migrate(db)