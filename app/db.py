"""Хранилище на SQLite (aiosqlite)."""

from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

import aiosqlite

from .scheduling import ScheduleSettings, fmt_hhmm

SCHEMA = """
CREATE TABLE IF NOT EXISTS services (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    price        INTEGER NOT NULL,
    duration_min INTEGER NOT NULL,
    is_active    INTEGER NOT NULL DEFAULT 1,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    username     TEXT    NOT NULL DEFAULT '',
    client_name  TEXT    NOT NULL,
    phone        TEXT    NOT NULL,
    date         TEXT    NOT NULL,              -- YYYY-MM-DD, местное время мастера
    start_min    INTEGER NOT NULL,              -- минуты от полуночи
    end_min      INTEGER NOT NULL,
    total_price  INTEGER NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'active',  -- active | cancelled
    cancelled_by TEXT,                          -- client | master
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id, status);

-- Снимок услуг на момент записи: цены и названия могут потом поменяться
CREATE TABLE IF NOT EXISTS booking_services (
    booking_id   INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    service_id   INTEGER,
    name         TEXT    NOT NULL,
    price        INTEGER NOT NULL,
    duration_min INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS days_off (
    date TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS users (
    user_id    INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '',
    last_name  TEXT NOT NULL DEFAULT '',
    username   TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

SERVICE_FIELDS = ("name", "description", "price", "duration_min", "is_active", "sort_order")


def _service(row: aiosqlite.Row) -> dict[str, Any]:
    data = dict(row)
    data["is_active"] = bool(data["is_active"])
    data.pop("created_at", None)
    return data


class Database:
    def __init__(self, path: Path | str):
        self.path = path
        self._conn: aiosqlite.Connection | None = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("База данных не подключена")
        return self._conn

    async def connect(self) -> None:
        if str(self.path) != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA foreign_keys = ON")
        if str(self.path) != ":memory:":
            await self._conn.execute("PRAGMA journal_mode = WAL")
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    # ---------- настройки расписания ----------

    async def get_schedule(self) -> ScheduleSettings:
        async with self.conn.execute("SELECT value FROM settings WHERE key = 'schedule'") as cur:
            row = await cur.fetchone()
        if row is None:
            return ScheduleSettings()
        return ScheduleSettings.model_validate_json(row["value"])

    async def save_schedule(self, schedule: ScheduleSettings) -> None:
        await self.conn.execute(
            "INSERT INTO settings(key, value) VALUES ('schedule', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (schedule.model_dump_json(),),
        )
        await self.conn.commit()

    async def list_days_off(self, from_date: date | None = None) -> list[str]:
        query, params = "SELECT date FROM days_off", ()
        if from_date:
            query, params = query + " WHERE date >= ?", (from_date.isoformat(),)
        async with self.conn.execute(query + " ORDER BY date", params) as cur:
            return [row["date"] for row in await cur.fetchall()]

    async def add_day_off(self, day: date) -> None:
        await self.conn.execute("INSERT OR IGNORE INTO days_off(date) VALUES (?)", (day.isoformat(),))
        await self.conn.commit()

    async def remove_day_off(self, day: date) -> None:
        await self.conn.execute("DELETE FROM days_off WHERE date = ?", (day.isoformat(),))
        await self.conn.commit()

    # ---------- услуги ----------

    async def list_services(self, active_only: bool = False) -> list[dict[str, Any]]:
        query = "SELECT * FROM services"
        if active_only:
            query += " WHERE is_active = 1"
        async with self.conn.execute(query + " ORDER BY sort_order, id") as cur:
            return [_service(row) for row in await cur.fetchall()]

    async def get_service(self, service_id: int) -> dict[str, Any] | None:
        async with self.conn.execute("SELECT * FROM services WHERE id = ?", (service_id,)) as cur:
            row = await cur.fetchone()
        return _service(row) if row else None

    async def get_services_by_ids(self, ids: list[int], active_only: bool = True) -> list[dict[str, Any]]:
        if not ids:
            return []
        marks = ",".join("?" * len(ids))
        query = f"SELECT * FROM services WHERE id IN ({marks})"
        if active_only:
            query += " AND is_active = 1"
        async with self.conn.execute(query + " ORDER BY sort_order, id", tuple(ids)) as cur:
            return [_service(row) for row in await cur.fetchall()]

    async def create_service(self, data: dict[str, Any]) -> dict[str, Any]:
        values = tuple(data[f] for f in SERVICE_FIELDS)
        cur = await self.conn.execute(
            f"INSERT INTO services({', '.join(SERVICE_FIELDS)}) VALUES ({', '.join('?' * len(SERVICE_FIELDS))})",
            values,
        )
        await self.conn.commit()
        return await self.get_service(cur.lastrowid)

    async def update_service(self, service_id: int, data: dict[str, Any]) -> dict[str, Any] | None:
        assignments = ", ".join(f"{f} = ?" for f in SERVICE_FIELDS)
        cur = await self.conn.execute(
            f"UPDATE services SET {assignments} WHERE id = ?",
            (*(data[f] for f in SERVICE_FIELDS), service_id),
        )
        await self.conn.commit()
        return await self.get_service(service_id) if cur.rowcount else None

    async def delete_service(self, service_id: int) -> bool:
        cur = await self.conn.execute("DELETE FROM services WHERE id = ?", (service_id,))
        await self.conn.commit()
        return cur.rowcount > 0

    # ---------- записи ----------

    async def busy_intervals(self, date_from: date, date_to: date) -> dict[str, list[tuple[int, int]]]:
        result: dict[str, list[tuple[int, int]]] = defaultdict(list)
        async with self.conn.execute(
            "SELECT date, start_min, end_min FROM bookings "
            "WHERE status = 'active' AND date BETWEEN ? AND ?",
            (date_from.isoformat(), date_to.isoformat()),
        ) as cur:
            for row in await cur.fetchall():
                result[row["date"]].append((row["start_min"], row["end_min"]))
        return result

    async def create_booking(
        self,
        *,
        user_id: int,
        username: str,
        client_name: str,
        phone: str,
        day: date,
        start_min: int,
        services: list[dict[str, Any]],
    ) -> int:
        duration = sum(s["duration_min"] for s in services)
        total = sum(s["price"] for s in services)
        cur = await self.conn.execute(
            "INSERT INTO bookings(user_id, username, client_name, phone, date, start_min, end_min, total_price) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, username, client_name, phone, day.isoformat(), start_min, start_min + duration, total),
        )
        booking_id = cur.lastrowid
        await self.conn.executemany(
            "INSERT INTO booking_services(booking_id, service_id, name, price, duration_min) VALUES (?, ?, ?, ?, ?)",
            [(booking_id, s["id"], s["name"], s["price"], s["duration_min"]) for s in services],
        )
        await self.conn.commit()
        return booking_id

    async def _attach_services(self, rows: list[aiosqlite.Row]) -> list[dict[str, Any]]:
        bookings = [dict(r) for r in rows]
        if not bookings:
            return []
        ids = [b["id"] for b in bookings]
        services: dict[int, list[dict[str, Any]]] = defaultdict(list)
        async with self.conn.execute(
            f"SELECT * FROM booking_services WHERE booking_id IN ({','.join('?' * len(ids))}) ORDER BY rowid",
            ids,
        ) as cur:
            for row in await cur.fetchall():
                services[row["booking_id"]].append(
                    {"service_id": row["service_id"], "name": row["name"], "price": row["price"],
                     "duration_min": row["duration_min"]}
                )
        for b in bookings:
            b["services"] = services[b["id"]]
            b["time"] = fmt_hhmm(b["start_min"])
            b["end_time"] = fmt_hhmm(b["end_min"])
            b["duration_min"] = b["end_min"] - b["start_min"]
        return bookings

    async def get_booking(self, booking_id: int) -> dict[str, Any] | None:
        async with self.conn.execute("SELECT * FROM bookings WHERE id = ?", (booking_id,)) as cur:
            row = await cur.fetchone()
        if row is None:
            return None
        return (await self._attach_services([row]))[0]

    async def list_bookings(
        self,
        *,
        user_id: int | None = None,
        status: str | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
        newest_first: bool = False,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        conditions, params = [], []
        if user_id is not None:
            conditions.append("user_id = ?")
            params.append(user_id)
        if status is not None:
            conditions.append("status = ?")
            params.append(status)
        if date_from is not None:
            conditions.append("date >= ?")
            params.append(date_from.isoformat())
        if date_to is not None:
            conditions.append("date <= ?")
            params.append(date_to.isoformat())
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        order = "DESC" if newest_first else "ASC"
        async with self.conn.execute(
            f"SELECT * FROM bookings {where} ORDER BY date {order}, start_min {order} LIMIT ?",
            (*params, limit),
        ) as cur:
            rows = await cur.fetchall()
        return await self._attach_services(rows)

    async def count_active_bookings(self, user_id: int, from_date: date) -> int:
        async with self.conn.execute(
            "SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'active' AND date >= ?",
            (user_id, from_date.isoformat()),
        ) as cur:
            return (await cur.fetchone())["n"]

    async def cancel_booking(self, booking_id: int, by: str) -> bool:
        cur = await self.conn.execute(
            "UPDATE bookings SET status = 'cancelled', cancelled_by = ? WHERE id = ? AND status = 'active'",
            (by, booking_id),
        )
        await self.conn.commit()
        return cur.rowcount > 0

    # ---------- клиенты ----------

    async def upsert_user(
        self, user_id: int, *, first_name: str = "", last_name: str = "", username: str = "", phone: str = ""
    ) -> None:
        await self.conn.execute(
            """
            INSERT INTO users(user_id, first_name, last_name, username, phone) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                first_name = excluded.first_name,
                last_name  = excluded.last_name,
                username   = excluded.username,
                phone      = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE users.phone END,
                updated_at = datetime('now')
            """,
            (user_id, first_name, last_name, username, phone),
        )
        await self.conn.commit()

    async def get_user(self, user_id: int) -> dict[str, Any] | None:
        async with self.conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)) as cur:
            row = await cur.fetchone()
        return dict(row) if row else None
