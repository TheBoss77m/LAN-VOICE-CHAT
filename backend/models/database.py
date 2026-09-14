"""
database.py
------------
[Model] طبقة الوصول لقاعدة البيانات وإدارة الجداول والبيانات الدائمة (SQLite عبر aiosqlite).
"""

import os
from datetime import datetime
from typing import Optional, List, Dict, Any

import aiosqlite

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB_PATH = os.path.join(BASE_DIR, "database", "chat.db")

_db: Optional[aiosqlite.Connection] = None


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


async def init_db() -> None:
    """يفتح الاتصال المشترك، وينشئ الجداول والفهارس إن لم تكن موجودة."""
    global _db
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    _db = await aiosqlite.connect(DB_PATH)
    _db.row_factory = aiosqlite.Row
    await _db.execute("PRAGMA journal_mode=WAL;")
    await _db.execute("PRAGMA foreign_keys=ON;")

    await _db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'offline',
            last_seen TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL REFERENCES users(id),
            receiver_id INTEGER NOT NULL REFERENCES users(id),
            message TEXT NOT NULL,
            timestamp TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_pair
            ON messages(sender_id, receiver_id);

        CREATE TABLE IF NOT EXISTS calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            caller_id INTEGER NOT NULL REFERENCES users(id),
            receiver_id INTEGER NOT NULL REFERENCES users(id),
            call_type TEXT NOT NULL DEFAULT 'voice',
            start_time TEXT NOT NULL,
            end_time TEXT,
            status TEXT NOT NULL DEFAULT 'ringing'
        );

        CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_by INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS group_members (
            group_id INTEGER NOT NULL REFERENCES groups(id),
            user_id INTEGER NOT NULL REFERENCES users(id),
            joined_at TEXT NOT NULL,
            PRIMARY KEY (group_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_group_members_user
            ON group_members(user_id);

        CREATE TABLE IF NOT EXISTS group_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES groups(id),
            sender_id INTEGER NOT NULL REFERENCES users(id),
            message TEXT NOT NULL,
            timestamp TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_group_messages_group
            ON group_messages(group_id);

        CREATE TABLE IF NOT EXISTS group_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES groups(id),
            started_by INTEGER NOT NULL REFERENCES users(id),
            start_time TEXT NOT NULL,
            end_time TEXT,
            status TEXT NOT NULL DEFAULT 'active'
        );

        CREATE TABLE IF NOT EXISTS group_call_participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            call_id INTEGER NOT NULL REFERENCES group_calls(id),
            user_id INTEGER NOT NULL REFERENCES users(id),
            joined_at TEXT NOT NULL,
            left_at TEXT
        );
        """
    )
    await _db.commit()

    # فحص توافق قواعد البيانات الموجودة مسبقًا لإضافة عمود call_type إن لم يكن موجودًا
    async with _db.execute("PRAGMA table_info(calls)") as cur:
        columns = [row[1] for row in await cur.fetchall()]
        if columns and "call_type" not in columns:
            await _db.execute("ALTER TABLE calls ADD COLUMN call_type TEXT NOT NULL DEFAULT 'voice'")
            await _db.commit()


async def close_db() -> None:
    global _db
    if _db is not None:
        await _db.close()
        _db = None


def _conn() -> aiosqlite.Connection:
    if _db is None:
        raise RuntimeError("قاعدة البيانات غير مهيأة بعد — تأكد من استدعاء init_db() أولًا")
    return _db


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

async def create_user(username: str, password_hash: str) -> Optional[int]:
    try:
        cursor = await _conn().execute(
            "INSERT INTO users (username, password_hash, status, last_seen) "
            "VALUES (?, ?, 'offline', ?)",
            (username, password_hash, _now()),
        )
        await _conn().commit()
        return cursor.lastrowid
    except aiosqlite.IntegrityError:
        return None


async def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    async with _conn().execute("SELECT * FROM users WHERE username = ?", (username,)) as cur:
        row = await cur.fetchone()
        return dict(row) if row else None


async def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    async with _conn().execute("SELECT * FROM users WHERE id = ?", (user_id,)) as cur:
        row = await cur.fetchone()
        return dict(row) if row else None


async def set_user_status(user_id: int, status: str) -> None:
    await _conn().execute(
        "UPDATE users SET status = ?, last_seen = ? WHERE id = ?", (status, _now(), user_id)
    )
    await _conn().commit()


async def list_users(exclude_id: Optional[int] = None) -> List[Dict[str, Any]]:
    if exclude_id is not None:
        query = (
            "SELECT id, username, status, last_seen FROM users "
            "WHERE id != ? ORDER BY username COLLATE NOCASE"
        )
        params: tuple = (exclude_id,)
    else:
        query = "SELECT id, username, status, last_seen FROM users ORDER BY username COLLATE NOCASE"
        params = ()
    async with _conn().execute(query, params) as cur:
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Messages (خاص - بين شخصين)
# ---------------------------------------------------------------------------

async def save_message(sender_id: int, receiver_id: int, message: str) -> Dict[str, Any]:
    timestamp = _now()
    cursor = await _conn().execute(
        "INSERT INTO messages (sender_id, receiver_id, message, timestamp) VALUES (?, ?, ?, ?)",
        (sender_id, receiver_id, message, timestamp),
    )
    await _conn().commit()
    return {
        "id": cursor.lastrowid,
        "sender_id": sender_id,
        "receiver_id": receiver_id,
        "message": message,
        "timestamp": timestamp,
    }


async def get_message_history(user_a: int, user_b: int, limit: int = 200) -> List[Dict[str, Any]]:
    async with _conn().execute(
        """
        SELECT * FROM messages
        WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
        ORDER BY id ASC LIMIT ?
        """,
        (user_a, user_b, user_b, user_a, limit),
    ) as cur:
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Calls (مكالمة ثنائية)
# ---------------------------------------------------------------------------

async def create_call(caller_id: int, receiver_id: int, call_type: str = "voice") -> int:
    cursor = await _conn().execute(
        "INSERT INTO calls (caller_id, receiver_id, call_type, start_time, status) VALUES (?, ?, ?, ?, 'ringing')",
        (caller_id, receiver_id, call_type, _now()),
    )
    await _conn().commit()
    return cursor.lastrowid


async def update_call_status(call_id: int, status: str, ended: bool = False) -> None:
    if ended:
        await _conn().execute(
            "UPDATE calls SET status = ?, end_time = ? WHERE id = ?", (status, _now(), call_id)
        )
    else:
        await _conn().execute("UPDATE calls SET status = ? WHERE id = ?", (status, call_id))
    await _conn().commit()


async def get_recent_calls(user_id: int, limit: int = 30) -> List[Dict[str, Any]]:
    async with _conn().execute(
        """
        SELECT c.*,
               u1.username AS caller_name,
               u2.username AS receiver_name
        FROM calls c
        JOIN users u1 ON u1.id = c.caller_id
        JOIN users u2 ON u2.id = c.receiver_id
        WHERE c.caller_id = ? OR c.receiver_id = ?
        ORDER BY c.id DESC LIMIT ?
        """,
        (user_id, user_id, limit),
    ) as cur:
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Groups (المجموعات)
# ---------------------------------------------------------------------------

async def create_group(name: str, created_by: int, member_ids: List[int]) -> int:
    cursor = await _conn().execute(
        "INSERT INTO groups (name, created_by, created_at) VALUES (?, ?, ?)",
        (name, created_by, _now()),
    )
    group_id = cursor.lastrowid

    all_members = set(member_ids) | {created_by}
    now = _now()
    await _conn().executemany(
        "INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
        [(group_id, uid, now) for uid in all_members],
    )
    await _conn().commit()
    return group_id


async def is_group_member(group_id: int, user_id: int) -> bool:
    async with _conn().execute(
        "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", (group_id, user_id)
    ) as cur:
        return (await cur.fetchone()) is not None


async def list_user_groups(user_id: int) -> List[Dict[str, Any]]:
    async with _conn().execute(
        """
        SELECT g.id, g.name, g.created_by,
               (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count
        FROM groups g
        JOIN group_members gm2 ON gm2.group_id = g.id
        WHERE gm2.user_id = ?
        ORDER BY g.name COLLATE NOCASE
        """,
        (user_id,),
    ) as cur:
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


async def get_group(group_id: int) -> Optional[Dict[str, Any]]:
    async with _conn().execute("SELECT * FROM groups WHERE id = ?", (group_id,)) as cur:
        row = await cur.fetchone()
        return dict(row) if row else None


async def list_group_member_ids(group_id: int) -> List[int]:
    async with _conn().execute(
        "SELECT user_id FROM group_members WHERE group_id = ?", (group_id,)
    ) as cur:
        rows = await cur.fetchall()
        return [r["user_id"] for r in rows]


async def list_group_members(group_id: int) -> List[Dict[str, Any]]:
    async with _conn().execute(
        """
        SELECT u.id, u.username, u.status, u.last_seen
        FROM users u
        JOIN group_members gm ON gm.user_id = u.id
        WHERE gm.group_id = ?
        ORDER BY u.username COLLATE NOCASE
        """,
        (group_id,),
    ) as cur:
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# رسائل المجموعات
# ---------------------------------------------------------------------------

async def save_group_message(group_id: int, sender_id: int, message: str) -> Dict[str, Any]:
    timestamp = _now()
    cursor = await _conn().execute(
        "INSERT INTO group_messages (group_id, sender_id, message, timestamp) VALUES (?, ?, ?, ?)",
        (group_id, sender_id, message, timestamp),
    )
    await _conn().commit()
    return {
        "id": cursor.lastrowid,
        "group_id": group_id,
        "sender_id": sender_id,
        "message": message,
        "timestamp": timestamp,
    }


async def get_group_message_history(group_id: int, limit: int = 200) -> List[Dict[str, Any]]:
    async with _conn().execute(
        "SELECT * FROM group_messages WHERE group_id = ? ORDER BY id ASC LIMIT ?",
        (group_id, limit),
    ) as cur:
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# مكالمات المجموعات (سجل تاريخي فقط)
# ---------------------------------------------------------------------------

async def create_group_call(group_id: int, started_by: int) -> int:
    cursor = await _conn().execute(
        "INSERT INTO group_calls (group_id, started_by, start_time, status) VALUES (?, ?, ?, 'active')",
        (group_id, started_by, _now()),
    )
    await _conn().commit()
    return cursor.lastrowid


async def end_group_call(call_id: int) -> None:
    await _conn().execute(
        "UPDATE group_calls SET status = 'ended', end_time = ? WHERE id = ?", (_now(), call_id)
    )
    await _conn().commit()


async def add_group_call_participant(call_id: int, user_id: int) -> None:
    await _conn().execute(
        "INSERT INTO group_call_participants (call_id, user_id, joined_at) VALUES (?, ?, ?)",
        (call_id, user_id, _now()),
    )
    await _conn().commit()


async def mark_group_call_participant_left(call_id: int, user_id: int) -> None:
    await _conn().execute(
        """
        UPDATE group_call_participants SET left_at = ?
        WHERE call_id = ? AND user_id = ? AND left_at IS NULL
        """,
        (_now(), call_id, user_id),
    )
    await _conn().commit()
