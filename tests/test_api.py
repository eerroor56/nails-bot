from .conftest import ADMIN_ID, MASTER_CHAT_ID, auth_headers

CLIENT_ID = 555
OTHER_ID = 777


def book(client, services, *, user_id=CLIENT_ID, date="2026-10-27", time="10:00", ids=None, phone="8 (999) 123-45-67"):
    body = {
        "service_ids": ids or [services[0]["id"], services[1]["id"]],
        "date": date,
        "time": time,
        "client_name": "Анна",
        "phone": phone,
    }
    return client.post("/api/bookings", json=body, headers=auth_headers(user_id))


def test_requires_telegram_auth(client):
    assert client.get("/api/me").status_code == 401
    response = client.get("/api/me", headers={"Authorization": "tma user=1&hash=bad"})
    assert response.status_code == 401


def test_static_pages_served(client):
    index = client.get("/")
    assert index.status_code == 200
    # Скрипт Telegram отдаётся с нашего сервера: telegram.org в России часто недоступен
    assert '<script src="js/telegram-web-app.js">' in index.text
    assert '<script src="https://telegram.org' not in index.text
    script = client.get("/js/telegram-web-app.js")
    assert script.status_code == 200
    assert "Telegram" in script.text
    assert '<script src="js/telegram-web-app.js">' in client.get("/admin.html").text
    assert client.get("/js/app.js").headers["Cache-Control"] == "no-cache"


def test_me_and_admin_flag(client, admin_headers):
    me = client.get("/api/me", headers=auth_headers(CLIENT_ID)).json()
    assert me["is_admin"] is False
    assert me["name"] == "Анна"
    assert me["salon_name"] == "Тестовая студия"
    assert client.get("/api/me", headers=admin_headers).json()["is_admin"] is True


def test_admin_endpoints_forbidden_for_clients(client):
    headers = auth_headers(CLIENT_ID)
    assert client.get("/api/admin/bookings", headers=headers).status_code == 403
    assert client.post("/api/admin/services", json={"name": "x", "price": 1, "duration_min": 30}, headers=headers).status_code == 403


def test_services_crud(client, admin_headers, services):
    # клиент видит только активные услуги
    visible = client.get("/api/services", headers=auth_headers(CLIENT_ID)).json()
    assert [s["name"] for s in visible] == ["Маникюр с покрытием", "Дизайн"]
    assert len(client.get("/api/admin/services", headers=admin_headers).json()) == 3

    service_id = services[1]["id"]
    body = {"name": "Дизайн (1 ноготь)", "price": 200, "duration_min": 15, "is_active": True}
    updated = client.put(f"/api/admin/services/{service_id}", json=body, headers=admin_headers)
    assert updated.status_code == 200
    assert updated.json()["price"] == 200

    assert client.delete(f"/api/admin/services/{service_id}", headers=admin_headers).status_code == 204
    assert client.delete(f"/api/admin/services/{service_id}", headers=admin_headers).status_code == 404

    bad = client.post("/api/admin/services", json={"name": "", "price": -1, "duration_min": 30}, headers=admin_headers)
    assert bad.status_code == 422
    assert isinstance(bad.json()["detail"], str)


def test_calendar_and_slots(client, services):
    headers = auth_headers(CLIENT_ID)
    ids = f"{services[0]['id']},{services[1]['id']}"  # 90 + 30 = 120 минут
    calendar = client.get(f"/api/calendar?month=2026-11&services={ids}", headers=headers).json()
    assert calendar["duration_min"] == 120
    assert calendar["min_month"] == "2026-10"
    assert "2026-11-01" not in calendar["days"]  # воскресенье
    assert "2026-11-02" in calendar["days"]
    assert max(calendar["days"]) <= "2026-11-24"  # горизонт 30 дней от 26.10

    slots = client.get(f"/api/slots?date=2026-10-26&services={ids}", headers=headers).json()["slots"]
    # сейчас 09:00, запись минимум за час, рабочий день 10–20, процедура 2 часа
    assert slots[0] == "10:00"
    assert slots[-1] == "18:00"

    inactive = client.get(f"/api/slots?date=2026-10-27&services={services[2]['id']}", headers=headers)
    assert inactive.status_code == 400


def test_booking_flow_sends_notifications(client, services, fake_bot):
    response = book(client, services)
    assert response.status_code == 201, response.text
    booking = response.json()
    assert booking["time"] == "10:00"
    assert booking["end_time"] == "12:00"
    assert booking["total_price"] == 3500
    assert booking["phone"] == "+79991234567"
    assert [s["name"] for s in booking["services"]] == ["Маникюр с покрытием", "Дизайн"]

    master = fake_bot.texts_for(MASTER_CHAT_ID)
    assert len(master) == 1
    assert master[0].startswith("<b>Новая запись!</b>")
    assert "Клиент: <a href=\"tg://user?id=555\">Анна</a> (@anna) / +79991234567" in master[0]
    assert "Услуга: Маникюр с покрытием, Дизайн" in master[0]
    assert "Дата и время: 27 октября 2026 (вт), 10:00–12:00" in master[0]
    assert "Сумма: 3 500 ₽" in master[0]

    client_messages = fake_bot.texts_for(CLIENT_ID)
    assert len(client_messages) == 1
    assert "Ваша запись на <b>27 октября 2026 (вт), 10:00</b> успешно оформлена!" in client_messages[0]

    # номер телефона запоминается для следующей записи
    assert client.get("/api/me", headers=auth_headers(CLIENT_ID)).json()["phone"] == "+79991234567"


def test_taken_and_overlapping_slots_rejected(client, services):
    assert book(client, services).status_code == 201  # 10:00–12:00
    assert book(client, services, user_id=OTHER_ID).status_code == 409
    assert book(client, services, user_id=OTHER_ID, time="11:30").status_code == 409
    assert book(client, services, user_id=OTHER_ID, time="12:00").status_code == 201

    slots = client.get(
        f"/api/slots?date=2026-10-27&services={services[0]['id']}", headers=auth_headers(OTHER_ID)
    ).json()["slots"]
    assert "10:00" not in slots and "11:30" not in slots and "14:00" in slots


def test_invalid_booking_requests(client, services):
    assert book(client, services, phone="123").status_code == 422
    assert "телефон" in book(client, services, phone="123").json()["detail"]
    assert book(client, services, time="10:15").status_code == 409  # не по сетке слотов
    assert book(client, services, date="2026-11-01").status_code == 409  # воскресенье
    assert book(client, services, date="2026-10-20").status_code == 409  # прошлое
    assert book(client, services, ids=[services[2]["id"]]).status_code == 400  # скрытая услуга


def test_active_bookings_limit(client, services):
    for day in ("2026-10-27", "2026-10-28", "2026-10-29"):
        assert book(client, services, date=day).status_code == 201
    response = book(client, services, date="2026-10-30")
    assert response.status_code == 403
    assert "активные записи" in response.json()["detail"]


def test_client_cancels_booking(client, services, fake_bot):
    booking = book(client, services).json()
    headers = auth_headers(CLIENT_ID)
    assert [b["id"] for b in client.get("/api/bookings/my", headers=headers).json()] == [booking["id"]]

    # чужую запись отменить нельзя
    assert client.post(f"/api/bookings/{booking['id']}/cancel", headers=auth_headers(OTHER_ID)).status_code == 404

    cancelled = client.post(f"/api/bookings/{booking['id']}/cancel", headers=headers)
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert client.get("/api/bookings/my", headers=headers).json() == []
    assert "Клиент отменил запись" in fake_bot.texts_for(MASTER_CHAT_ID)[-1]

    # освободившееся время снова можно занять
    assert book(client, services, user_id=OTHER_ID).status_code == 201


def test_admin_sees_and_cancels_bookings(client, services, fake_bot, admin_headers):
    booking = book(client, services).json()
    upcoming = client.get("/api/admin/bookings", headers=admin_headers).json()
    assert [b["id"] for b in upcoming] == [booking["id"]]
    assert upcoming[0]["phone"] == "+79991234567"

    response = client.post(f"/api/admin/bookings/{booking['id']}/cancel", headers=admin_headers)
    assert response.status_code == 200
    assert response.json()["cancelled_by"] == "master"
    assert "отменена мастером" in fake_bot.texts_for(CLIENT_ID)[-1]
    assert client.post(f"/api/admin/bookings/{booking['id']}/cancel", headers=admin_headers).status_code == 404


def test_admin_rules_and_work_days(client, services, admin_headers):
    headers = auth_headers(CLIENT_ID)
    ids = services[0]["id"]  # 90 минут

    data = client.get("/api/admin/schedule", headers=admin_headers).json()
    assert data["today"] == "2026-10-26"
    assert data["days"]["2026-10-27"] == {"start": "10:00", "end": "20:00", "breaks": []}
    assert "2026-11-01" not in data["days"]  # воскресенье — выходной
    schedule = data["schedule"]
    assert schedule == {"slot_step": 30, "horizon_days": 30, "min_lead_minutes": 60}
    schedule["slot_step"] = 60
    assert client.put("/api/admin/schedule", json=schedule, headers=admin_headers).status_code == 200
    assert client.put("/api/admin/schedule", json={**schedule, "slot_step": 20}, headers=admin_headers).status_code == 422

    def set_days(dates, day):
        return client.put("/api/admin/days", json={"dates": dates, "day": day}, headers=admin_headers)

    # Вторник: 10–15 с обедом 12–13
    lunch = {"start": "10:00", "end": "15:00", "breaks": [{"start": "12:00", "end": "13:00"}]}
    assert set_days(["2026-10-27"], lunch).json()["days"]["2026-10-27"] == lunch
    slots = client.get(f"/api/slots?date=2026-10-27&services={ids}", headers=headers).json()["slots"]
    assert slots == ["10:00", "13:00"]  # 90 минут, шаг 1 час, обед 12–13, до 15:00

    # Отпуск на два дня и рабочее воскресенье
    assert set_days(["2026-10-28", "2026-10-29"], None).status_code == 200
    assert set_days(["2026-11-01"], {"start": "11:00", "end": "14:00"}).status_code == 200
    calendar = client.get(f"/api/calendar?month=2026-10&services={ids}", headers=headers).json()
    assert "2026-10-28" not in calendar["days"]
    assert "2026-10-29" not in calendar["days"]
    assert "2026-10-30" in calendar["days"]
    slots = client.get(f"/api/slots?date=2026-11-01&services={ids}", headers=headers).json()["slots"]
    assert slots == ["11:00", "12:00"]

    assert set_days(["2026-10-01"], None).status_code == 400  # прошлое
    assert set_days(["2027-12-01"], lunch).status_code == 400  # дальше года
    assert set_days(["2026-11-02"], {"start": "15:00", "end": "12:00"}).status_code == 422
    outside = {"start": "10:00", "end": "15:00", "breaks": [{"start": "14:00", "end": "16:00"}]}
    assert set_days(["2026-11-02"], outside).status_code == 422
    assert set_days([], None).status_code == 422


def test_admin_schedule_lists_bookings(client, services, admin_headers):
    booking = book(client, services).json()
    bookings = client.get("/api/admin/schedule", headers=admin_headers).json()["bookings"]
    assert [(b["id"], b["date"], b["time"]) for b in bookings] == [(booking["id"], "2026-10-27", "10:00")]


def test_notifications_fall_back_to_admins(tmp_path, fake_bot):
    from fastapi.testclient import TestClient

    from app.config import Settings
    from app.main import create_app

    from .conftest import BOT_TOKEN, NOW, open_work_days

    settings = Settings(bot_token=BOT_TOKEN, admin_ids=(ADMIN_ID,), database_path=tmp_path / "db.sqlite")
    app = create_app(settings, bot=fake_bot, run_bot=False, clock=lambda: NOW)
    with TestClient(app) as client:
        admin = auth_headers(ADMIN_ID)
        open_work_days(client, admin)
        service = client.post("/api/admin/services", json={"name": "Педикюр", "price": 3000, "duration_min": 60}, headers=admin).json()
        assert book(client, [service], ids=[service["id"]]).status_code == 201
    assert "Новая запись!" in fake_bot.texts_for(ADMIN_ID)[0]
