import json
import time
from datetime import date, datetime, timedelta
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.auth import sign_init_data
from app.config import Settings
from app.main import create_app

BOT_TOKEN = "123456:TEST-TOKEN"
ADMIN_ID = 100
MASTER_CHAT_ID = -1001234567890
TZ = ZoneInfo("Europe/Moscow")
# Понедельник, 26 октября 2026, 09:00 по Москве
NOW = datetime(2026, 10, 26, 9, 0, tzinfo=TZ)


def make_init_data(user: dict, token: str = BOT_TOKEN, auth_date: int | None = None) -> str:
    fields = {
        "query_id": "AAH",
        "user": json.dumps(user, ensure_ascii=False, separators=(",", ":")),
        "auth_date": str(auth_date if auth_date is not None else int(time.time())),
    }
    fields["hash"] = sign_init_data(fields, token)
    return urlencode(fields)


def auth_headers(user_id: int, first_name: str = "Анна", username: str = "anna") -> dict[str, str]:
    user = {"id": user_id, "first_name": first_name, "username": username, "language_code": "ru"}
    return {"Authorization": "tma " + make_init_data(user)}


class FakeBot:
    """Вместо настоящего бота: запоминает отправленные сообщения."""

    def __init__(self):
        self.sent: list[dict] = []

    async def send_message(self, chat_id, text, **kwargs):
        self.sent.append({"chat_id": chat_id, "text": text, **kwargs})

    def texts_for(self, chat_id) -> list[str]:
        return [m["text"] for m in self.sent if m["chat_id"] == chat_id]


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        bot_token=BOT_TOKEN,
        webapp_url="https://nails.example.com",
        admin_ids=(ADMIN_ID,),
        master_chat_id=MASTER_CHAT_ID,
        database_path=tmp_path / "test.db",
        salon_name="Тестовая студия",
    )


@pytest.fixture
def fake_bot() -> FakeBot:
    return FakeBot()


@pytest.fixture
def client(settings, fake_bot):
    app = create_app(settings, bot=fake_bot, run_bot=False, clock=lambda: NOW)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def admin_headers() -> dict[str, str]:
    return auth_headers(ADMIN_ID, "Мастер", "master")


def open_work_days(client, headers) -> None:
    """Расписывает календарь, как было в обычной неделе: пн–пт 10–20, сб 10–18, вс выходной."""
    weekdays, saturdays = [], []
    day = NOW.date()
    while day <= date(2026, 12, 31):
        if day.weekday() < 5:
            weekdays.append(day.isoformat())
        elif day.weekday() == 5:
            saturdays.append(day.isoformat())
        day += timedelta(days=1)
    for dates, end in ((weekdays, "20:00"), (saturdays, "18:00")):
        response = client.put("/api/admin/days", json={"dates": dates, "day": {"start": "10:00", "end": end}}, headers=headers)
        assert response.status_code == 200, response.text


@pytest.fixture
def services(client, admin_headers) -> list[dict]:
    open_work_days(client, admin_headers)
    created = []
    for body in (
        {"name": "Маникюр с покрытием", "description": "Гель-лак", "price": 2500, "duration_min": 90},
        {"name": "Дизайн", "price": 1000, "duration_min": 30},
        {"name": "Снятие", "price": 300, "duration_min": 30, "is_active": False},
    ):
        response = client.post("/api/admin/services", json=body, headers=admin_headers)
        assert response.status_code == 201, response.text
        created.append(response.json())
    return created
