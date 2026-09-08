"""SQLite store for the astro bot: users, birth details, question quota, audit log.

Everything a paying customer is owed lives here. Quota is decremented only after an
answer passes the hallucination guard and is actually delivered (see flow.py).
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

DB_PATH = os.environ.get("ASTRO_DB", str(Path(__file__).parent / "astro.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  phone      TEXT PRIMARY KEY,
  name       TEXT,
  dob        TEXT,          -- YYYY-MM-DD
  birth_time TEXT,          -- HH:MM 24h, NULL if unknown
  place      TEXT,
  gender     TEXT,
  state      TEXT NOT NULL DEFAULT 'new',
  language   TEXT,          -- 'en' or 'hi', chosen once at first contact — see flow.py
  pending_question TEXT,    -- a real question asked before onboarding finished — see flow.py
  created_at REAL, updated_at REAL
);
CREATE TABLE IF NOT EXISTS factpacks (
  phone TEXT PRIMARY KEY, generated_at REAL, json TEXT
);
CREATE TABLE IF NOT EXISTS entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL, order_name TEXT, sku TEXT, source TEXT,
  questions_total INTEGER NOT NULL, questions_used INTEGER NOT NULL DEFAULT 0,
  created_at REAL,
  UNIQUE(phone, order_name, sku)   -- one grant per order line; re-verification is idempotent
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL, asked_at REAL, topic TEXT,
  question TEXT, answer TEXT,
  guard_status TEXT, guard_notes TEXT, model TEXT, entitlement_id INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT, direction TEXT, body TEXT, ts REAL
);
CREATE INDEX IF NOT EXISTS idx_ent_phone ON entitlements(phone);
CREATE INDEX IF NOT EXISTS idx_q_phone   ON questions(phone);
"""


def conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init() -> None:
    with conn() as c:
        c.executescript(SCHEMA)
        # CREATE TABLE IF NOT EXISTS doesn't add columns to an already-existing table — migrate
        # pending_question in for databases created before this column existed.
        cols = {r["name"] for r in c.execute("PRAGMA table_info(users)")}
        if "pending_question" not in cols:
            c.execute("ALTER TABLE users ADD COLUMN pending_question TEXT")
        if "language" not in cols:
            c.execute("ALTER TABLE users ADD COLUMN language TEXT")


# ── users ────────────────────────────────────────────────────────────────
def get_user(phone: str) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM users WHERE phone=?", (phone,)).fetchone()
    return dict(r) if r else None


def upsert_user(phone: str, **fields) -> dict:
    now = time.time()
    u = get_user(phone)
    with conn() as c:
        if u is None:
            c.execute("INSERT INTO users(phone, state, created_at, updated_at) VALUES(?,?,?,?)",
                      (phone, fields.pop("state", "new"), now, now))
        if fields:
            cols = ", ".join(f"{k}=?" for k in fields)
            c.execute(f"UPDATE users SET {cols}, updated_at=? WHERE phone=?",
                      (*fields.values(), now, phone))
    return get_user(phone)


def reset_user(phone: str) -> None:
    """Wipe birth details + cached chart so the customer can re-enter them. Quota is kept."""
    with conn() as c:
        c.execute("UPDATE users SET name=NULL, dob=NULL, birth_time=NULL, place=NULL,"
                  " state='new', updated_at=? WHERE phone=?", (time.time(), phone))
        c.execute("DELETE FROM factpacks WHERE phone=?", (phone,))


# ── fact-pack cache ──────────────────────────────────────────────────────
# Transits move daily, so a cached pack is only good for a few hours.
FACTPACK_TTL = 6 * 3600


def get_factpack(phone: str) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT generated_at, json FROM factpacks WHERE phone=?", (phone,)).fetchone()
    if not r or (time.time() - r["generated_at"]) > FACTPACK_TTL:
        return None
    return json.loads(r["json"])


def put_factpack(phone: str, pack: dict) -> None:
    with conn() as c:
        c.execute("INSERT INTO factpacks(phone, generated_at, json) VALUES(?,?,?)"
                  " ON CONFLICT(phone) DO UPDATE SET generated_at=excluded.generated_at,"
                  " json=excluded.json", (phone, time.time(), json.dumps(pack)))


def clear_factpack(phone: str) -> None:
    with conn() as c:
        c.execute("DELETE FROM factpacks WHERE phone=?", (phone,))


# ── quota ────────────────────────────────────────────────────────────────
def grant(phone: str, questions: int, order_name: str = "", sku: str = "", source: str = "shopify") -> bool:
    """Add a question pack. Returns False if this exact order line was already granted."""
    try:
        with conn() as c:
            c.execute("INSERT INTO entitlements(phone, order_name, sku, source, questions_total,"
                      " questions_used, created_at) VALUES(?,?,?,?,?,0,?)",
                      (phone, order_name, sku, source, questions, time.time()))
        return True
    except sqlite3.IntegrityError:
        return False


def remaining(phone: str) -> int:
    with conn() as c:
        r = c.execute("SELECT COALESCE(SUM(questions_total - questions_used), 0) AS n"
                      " FROM entitlements WHERE phone=?", (phone,)).fetchone()
    return int(r["n"] or 0)


def consume(phone: str) -> int | None:
    """Burn one question off the oldest pack with balance. Returns the entitlement id, or None.

    Single atomic UPDATE...RETURNING, not a SELECT-then-UPDATE. Today the per-phone lock in
    server.py already serializes every call to this function, so a SELECT-then-UPDATE race
    can't actually happen yet — but that safety lives in server.py's threading discipline, not
    in this function, so it silently breaks the moment any other caller (an admin script, a
    retry job, a future second webhook path) calls consume() without going through that lock.
    Doing the read-and-write as one statement makes double-spending a single question
    structurally impossible regardless of what calls this later.
    """
    with conn() as c:
        r = c.execute(
            "UPDATE entitlements SET questions_used = questions_used + 1 "
            "WHERE id = (SELECT id FROM entitlements WHERE phone=? AND questions_used < questions_total "
            "            ORDER BY created_at LIMIT 1) "
            "RETURNING id", (phone,)).fetchone()
        return int(r["id"]) if r else None


def refund(entitlement_id: int) -> None:
    """Give a question back — used when delivery fails after the quota was consumed."""
    with conn() as c:
        c.execute("UPDATE entitlements SET questions_used = MAX(questions_used - 1, 0) WHERE id=?",
                  (entitlement_id,))


# ── logs ─────────────────────────────────────────────────────────────────
def log_message(phone: str, direction: str, body: str) -> None:
    with conn() as c:
        c.execute("INSERT INTO messages(phone, direction, body, ts) VALUES(?,?,?,?)",
                  (phone, direction, body, time.time()))


def log_question(phone: str, topic: str, question: str, answer: str,
                 guard_status: str, guard_notes: str, model: str, entitlement_id) -> None:
    with conn() as c:
        c.execute("INSERT INTO questions(phone, asked_at, topic, question, answer, guard_status,"
                  " guard_notes, model, entitlement_id) VALUES(?,?,?,?,?,?,?,?,?)",
                  (phone, time.time(), topic, question, answer, guard_status,
                   guard_notes, model, entitlement_id))


def get_recent_qa(phone: str, limit: int = 3) -> list[dict]:
    """Last N successfully-answered exchanges, oldest first — conversation memory for the
    prompt. Only 'clean'/'repaired' answers qualify; a 'fallback' is the deterministic
    facts-only template, not something worth feeding back as prior conversational content.
    Each entry also carries `topic`, so a vague follow-up ("tell me more") can inherit the
    topic actually being discussed instead of falling through to a generic fact set."""
    with conn() as c:
        rows = c.execute(
            "SELECT question, answer, topic FROM questions WHERE phone=? AND guard_status IN ('clean','repaired') "
            "ORDER BY id DESC LIMIT ?", (phone, limit)).fetchall()
    return [{"question": r["question"], "answer": r["answer"], "topic": r["topic"]} for r in reversed(rows)]


def question_count(phone: str) -> int:
    with conn() as c:
        r = c.execute("SELECT COUNT(*) AS n FROM questions WHERE phone=?", (phone,)).fetchone()
    return int(r["n"])


if __name__ == "__main__":
    init()
    print(f"initialised {DB_PATH}")
