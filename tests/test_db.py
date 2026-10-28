from datetime import date

import aiosqlite

from app.db import Database


async def test_old_days_off_become_special_days(tmp_path):
    path = tmp_path / "old.db"
    # База установленного раньше бота: выходные по датам — в таблице days_off
    async with aiosqlite.connect(path) as conn:
        await conn.execute("CREATE TABLE days_off (date TEXT PRIMARY KEY)")
        await conn.executemany("INSERT INTO days_off(date) VALUES (?)", [("2026-10-27",), ("2026-11-03",)])
        await conn.commit()

    db = Database(path)
    await db.connect()
    try:
        special = await db.list_special_days(date(2026, 10, 1))
        assert sorted(special) == ["2026-10-27", "2026-11-03"]
        assert not special["2026-10-27"].enabled
        async with db.conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'days_off'") as cur:
            assert await cur.fetchone() is None
    finally:
        await db.close()

    # Повторный запуск ничего не ломает
    db = Database(path)
    await db.connect()
    try:
        assert len(await db.list_special_days(date(2026, 10, 1))) == 2
    finally:
        await db.close()
