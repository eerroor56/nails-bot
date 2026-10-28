import json
from datetime import date, timedelta

import aiosqlite

from app.db import Database


async def make_old_db(path, week=None, special=(), days_off=()):
    """База бота до календаря: обычная неделя в настройках и исключения в отдельных таблицах."""
    async with aiosqlite.connect(path) as conn:
        await conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        if week is not None:
            schedule = {"slot_step": 60, "horizon_days": 14, "min_lead_minutes": 0, "week": week}
            await conn.execute("INSERT INTO settings VALUES ('schedule', ?)", (json.dumps(schedule),))
        await conn.execute(
            "CREATE TABLE special_days (date TEXT PRIMARY KEY, enabled INTEGER NOT NULL, "
            "start_min INTEGER NOT NULL, end_min INTEGER NOT NULL)"
        )
        await conn.executemany("INSERT INTO special_days VALUES (?, ?, ?, ?)", special)
        if days_off:
            await conn.execute("CREATE TABLE days_off (date TEXT PRIMARY KEY)")
            await conn.executemany("INSERT INTO days_off VALUES (?)", [(d,) for d in days_off])
        await conn.commit()


def next_weekday(weekday: int) -> date:
    day = date.today() + timedelta(days=1)
    while day.weekday() != weekday:
        day += timedelta(days=1)
    return day


async def test_old_week_becomes_work_days(tmp_path):
    path = tmp_path / "old.db"
    week = [{"enabled": True, "start": "09:00", "end": "18:00"}] * 6 + [{"enabled": False, "start": "10:00", "end": "20:00"}]
    monday, tuesday, wednesday, sunday = (next_weekday(i) for i in (0, 1, 2, 6))
    await make_old_db(
        path,
        week,
        special=[(monday.isoformat(), 0, 600, 1200), (sunday.isoformat(), 1, 660, 840)],
        days_off=[tuesday.isoformat()],
    )

    db = Database(path)
    await db.connect()
    try:
        days = await db.list_work_days(date.today())
        assert days[wednesday.isoformat()].start == "09:00"  # по обычной неделе
        assert monday.isoformat() not in days  # выходной из календаря
        assert tuesday.isoformat() not in days  # выходной из старой таблицы
        assert days[sunday.isoformat()].end == "14:00"  # рабочее воскресенье
        assert max(days) >= (date.today() + timedelta(days=360)).isoformat()  # неделя расписана на год
        schedule = await db.get_schedule()
        assert (schedule.slot_step, schedule.horizon_days) == (60, 14)  # правила записи сохранились
        async with db.conn.execute("SELECT name FROM sqlite_master WHERE name IN ('special_days', 'days_off')") as cur:
            assert await cur.fetchall() == []
        async with db.conn.execute("SELECT value FROM settings WHERE key = 'schedule'") as cur:
            assert "week" not in json.loads((await cur.fetchone())["value"])
    finally:
        await db.close()

    # Повторный запуск ничего не меняет
    db = Database(path)
    await db.connect()
    try:
        assert monday.isoformat() not in await db.list_work_days(date.today())
    finally:
        await db.close()


async def test_old_default_week_when_schedule_never_saved(tmp_path):
    path = tmp_path / "old.db"
    await make_old_db(path)
    db = Database(path)
    await db.connect()
    try:
        days = await db.list_work_days(date.today())
        assert days[next_weekday(5).isoformat()].end == "18:00"  # суббота по умолчанию 10–18
        assert next_weekday(6).isoformat() not in days
    finally:
        await db.close()


async def test_new_install_has_no_work_days(tmp_path):
    db = Database(tmp_path / "new.db")
    await db.connect()
    try:
        assert await db.list_work_days(date.today()) == {}
    finally:
        await db.close()
