"""HTTP API для Mini App: клиентская часть и админ-панель мастера."""

import asyncio
import re
from calendar import monthrange
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from .auth import InitDataError, TgUser, validate_init_data
from .config import Settings
from .db import Database
from .notifications import Notifier
from .scheduling import (
    DAYS_AHEAD,
    TIME_PATTERN,
    ScheduleSettings,
    WorkDay,
    bookable_range,
    day_slots,
    fmt_hhmm,
    parse_hhmm,
)

# ---------- зависимости ----------


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Database:
    return request.app.state.db


def get_notifier(request: Request) -> Notifier:
    return request.app.state.notifier


def master_tz(schedule: ScheduleSettings, settings: Settings) -> ZoneInfo:
    """Часовой пояс из правил записи, а пока мастер его не выбрал — TIMEZONE с сервера."""
    return ZoneInfo(schedule.timezone or settings.timezone)


def get_now(request: Request) -> datetime:
    # Время мастера: от него зависят «сегодня», свободные окна и то, какие записи уже прошли
    return request.app.state.clock().astimezone(request.app.state.tz)


def current_user(request: Request, settings: Settings = Depends(get_settings)) -> TgUser:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("tma "):
        try:
            return validate_init_data(auth[4:], settings.bot_token, settings.init_data_ttl)
        except InitDataError as exc:
            raise HTTPException(401, str(exc)) from exc
    if settings.dev_mode:
        return TgUser(id=settings.dev_user_id, first_name="Гость", username="dev", is_dev=True)
    raise HTTPException(401, "Откройте приложение через Telegram")


def is_admin(user: TgUser, settings: Settings) -> bool:
    return user.id in settings.admin_ids or user.is_dev


def require_admin(user: TgUser = Depends(current_user), settings: Settings = Depends(get_settings)) -> TgUser:
    if not is_admin(user, settings):
        raise HTTPException(403, "Доступ только для мастера")
    return user


# ---------- модели ----------


def normalize_phone(raw: str) -> str:
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 11 and digits.startswith("8"):
        digits = "7" + digits[1:]
    elif len(digits) == 10 and digits.startswith("9"):
        digits = "7" + digits
    if not 10 <= len(digits) <= 15:
        raise ValueError("Укажите корректный номер телефона")
    return "+" + digits


class BookingIn(BaseModel):
    service_ids: list[int] = Field(min_length=1, max_length=20)
    date: date
    time: str = Field(pattern=TIME_PATTERN)
    client_name: str = Field(min_length=1, max_length=64)
    phone: str = Field(max_length=32)
    # Пожелания клиента к записи, необязательно
    comment: str = Field(default="", max_length=500)

    @field_validator("client_name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = " ".join(value.split())
        if len(value) < 2:
            raise ValueError("Укажите имя")
        return value

    @field_validator("comment")
    @classmethod
    def _comment(cls, value: str) -> str:
        return value.strip()

    @field_validator("phone")
    @classmethod
    def _phone(cls, value: str) -> str:
        return normalize_phone(value)


class ServiceIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)
    # Группа, под которой клиент видит услугу, например «Маникюр»; пустая — без группы
    category: str = Field(default="", max_length=50)
    price: int = Field(ge=0, le=10_000_000)
    duration_min: int = Field(ge=5, le=12 * 60)
    is_active: bool = True
    sort_order: int = Field(default=0, ge=-10_000, le=10_000)

    @field_validator("name", "description")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()

    @field_validator("category")
    @classmethod
    def _category(cls, value: str) -> str:
        # Заголовок группы у клиента: «педикюр» → «Педикюр»
        value = " ".join(value.split())
        return value[:1].upper() + value[1:]


class WorkDaysIn(BaseModel):
    dates: list[date] = Field(min_length=1, max_length=DAYS_AHEAD + 1)
    # None — выходной
    day: WorkDay | None


# ---------- вспомогательное ----------


def parse_service_ids(raw: str) -> list[int]:
    try:
        ids = [int(x) for x in raw.split(",") if x.strip()]
    except ValueError as exc:
        raise HTTPException(400, "Некорректный список услуг") from exc
    if not ids:
        raise HTTPException(400, "Выберите хотя бы одну услугу")
    return list(dict.fromkeys(ids))


async def resolve_services(db: Database, ids: list[int]) -> list[dict[str, Any]]:
    services = await db.get_services_by_ids(ids)
    if len(services) != len(ids):
        raise HTTPException(400, "Одна из выбранных услуг больше недоступна, обновите список")
    return services


async def slots_for_day(db: Database, day: date, duration: int, now: datetime) -> list[int]:
    schedule = await db.get_schedule()
    work_days = await db.list_work_days(day, day)
    busy = await db.busy_intervals(day, day)
    return day_slots(day, schedule, work_days, busy.get(day.isoformat(), []), duration, now)


async def canonical_category(db: Database, category: str, service_id: int | None = None) -> str:
    """«маникюр» относим к уже заведённой группе «Маникюр», чтобы у клиента не появилось двух одинаковых групп."""
    for service in await db.list_services():
        if service["id"] != service_id and service["category"].casefold() == category.casefold():
            return service["category"]
    return category


def booking_phase(booking: dict[str, Any], now: datetime) -> str:
    """upcoming — ещё не началась, ongoing — идёт сейчас, finished — уже закончилась."""
    today = now.date().isoformat()
    if booking["date"] != today:
        return "upcoming" if booking["date"] > today else "finished"
    now_min = now.hour * 60 + now.minute
    if booking["end_min"] <= now_min:
        return "finished"
    return "ongoing" if booking["start_min"] <= now_min else "upcoming"


def is_upcoming(booking: dict[str, Any], now: datetime) -> bool:
    return booking_phase(booking, now) != "finished"


def with_phase(bookings: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    for booking in bookings:
        booking["phase"] = booking_phase(booking, now)
    return bookings


async def upcoming_bookings(db: Database, user_id: int, now: datetime) -> list[dict[str, Any]]:
    bookings = await db.list_bookings(user_id=user_id, status="active", date_from=now.date())
    return [b for b in bookings if is_upcoming(b, now)]


# ---------- клиент ----------

router = APIRouter(prefix="/api")


@router.get("/me")
async def me(
    user: TgUser = Depends(current_user),
    settings: Settings = Depends(get_settings),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    saved = await db.get_user(user.id)
    last = await db.list_bookings(user_id=user.id, newest_first=True, limit=1)
    return {
        "id": user.id,
        "first_name": user.first_name,
        "username": user.username,
        "name": last[0]["client_name"] if last else user.full_name,
        "phone": (saved or {}).get("phone") or (last[0]["phone"] if last else ""),
        "is_admin": is_admin(user, settings),
        "salon_name": settings.salon_name,
        "currency": settings.currency,
    }


@router.get("/services")
async def services(_: TgUser = Depends(current_user), db: Database = Depends(get_db)) -> list[dict[str, Any]]:
    return await db.list_services(active_only=True)


@router.get("/calendar")
async def calendar(
    month: str = Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$"),
    services: str = Query(),
    _: TgUser = Depends(current_user),
    db: Database = Depends(get_db),
    now: datetime = Depends(get_now),
) -> dict[str, Any]:
    chosen = await resolve_services(db, parse_service_ids(services))
    duration = sum(s["duration_min"] for s in chosen)
    schedule = await db.get_schedule()
    first, last = bookable_range(schedule, now)

    year, mon = map(int, month.split("-"))
    start = max(first, date(year, mon, 1))
    end = min(last, date(year, mon, monthrange(year, mon)[1]))
    days: dict[str, int] = {}
    if start <= end:
        work_days = await db.list_work_days(start, end)
        busy = await db.busy_intervals(start, end)
        day = start
        while day <= end:
            slots = day_slots(day, schedule, work_days, busy.get(day.isoformat(), []), duration, now)
            if slots:
                days[day.isoformat()] = len(slots)
            day += timedelta(days=1)
    return {
        "month": month,
        "min_month": first.strftime("%Y-%m"),
        "max_month": last.strftime("%Y-%m"),
        "duration_min": duration,
        "days": days,
    }


@router.get("/slots")
async def slots(
    day: date = Query(alias="date"),
    services: str = Query(),
    _: TgUser = Depends(current_user),
    db: Database = Depends(get_db),
    now: datetime = Depends(get_now),
) -> dict[str, Any]:
    chosen = await resolve_services(db, parse_service_ids(services))
    duration = sum(s["duration_min"] for s in chosen)
    free = await slots_for_day(db, day, duration, now)
    return {"date": day.isoformat(), "duration_min": duration, "slots": [fmt_hhmm(m) for m in free]}


@router.post("/bookings", status_code=201)
async def create_booking(
    payload: BookingIn,
    request: Request,
    background: BackgroundTasks,
    user: TgUser = Depends(current_user),
    settings: Settings = Depends(get_settings),
    db: Database = Depends(get_db),
    notifier: Notifier = Depends(get_notifier),
    now: datetime = Depends(get_now),
) -> dict[str, Any]:
    chosen = await resolve_services(db, list(dict.fromkeys(payload.service_ids)))
    duration = sum(s["duration_min"] for s in chosen)
    start = parse_hhmm(payload.time)

    lock: asyncio.Lock = request.app.state.booking_lock
    async with lock:
        if len(await upcoming_bookings(db, user.id, now)) >= settings.max_active_bookings:
            raise HTTPException(
                403, f"У вас уже {settings.max_active_bookings} активные записи. Отмените одну из них или дождитесь визита"
            )
        if start not in await slots_for_day(db, payload.date, duration, now):
            raise HTTPException(409, "Это время уже занято. Пожалуйста, выберите другое")
        booking_id = await db.create_booking(
            user_id=user.id,
            username=user.username,
            client_name=payload.client_name,
            phone=payload.phone,
            day=payload.date,
            start_min=start,
            services=chosen,
            comment=payload.comment,
        )

    await db.upsert_user(
        user.id, first_name=user.first_name, last_name=user.last_name, username=user.username, phone=payload.phone
    )
    booking = await db.get_booking(booking_id)
    background.add_task(notifier.booking_created, booking)
    return booking


@router.get("/bookings/my")
async def my_bookings(
    user: TgUser = Depends(current_user),
    db: Database = Depends(get_db),
    now: datetime = Depends(get_now),
) -> list[dict[str, Any]]:
    return await upcoming_bookings(db, user.id, now)


@router.post("/bookings/{booking_id}/cancel")
async def cancel_my_booking(
    booking_id: int,
    background: BackgroundTasks,
    user: TgUser = Depends(current_user),
    db: Database = Depends(get_db),
    notifier: Notifier = Depends(get_notifier),
    now: datetime = Depends(get_now),
) -> dict[str, Any]:
    booking = await db.get_booking(booking_id)
    if booking is None or booking["user_id"] != user.id:
        raise HTTPException(404, "Запись не найдена")
    if booking["status"] != "active":
        raise HTTPException(409, "Запись уже отменена")
    starts_at = datetime.fromisoformat(booking["date"]) + timedelta(minutes=booking["start_min"])
    if starts_at <= now.replace(tzinfo=None):
        raise HTTPException(409, "Нельзя отменить запись, которая уже началась")
    await db.cancel_booking(booking_id, by="client")
    booking = await db.get_booking(booking_id)
    background.add_task(notifier.booking_cancelled_by_client, booking)
    return booking


# ---------- админ-панель ----------

admin = APIRouter(prefix="/api/admin", dependencies=[Depends(require_admin)])


@admin.get("/bookings")
async def admin_bookings(
    scope: str = Query(default="upcoming", pattern="^(upcoming|past)$"),
    db: Database = Depends(get_db),
    now: datetime = Depends(get_now),
) -> list[dict[str, Any]]:
    # Запись уходит в прошедшие, когда закончилась, а не на следующий день
    today = now.date()
    if scope == "upcoming":
        bookings = [b for b in await db.list_bookings(date_from=today) if is_upcoming(b, now)]
    else:
        bookings = await db.list_bookings(date_to=today, newest_first=True, limit=100)
        bookings = [b for b in bookings if not is_upcoming(b, now)]
    return with_phase(bookings, now)


@admin.post("/bookings/{booking_id}/cancel")
async def admin_cancel_booking(
    booking_id: int,
    background: BackgroundTasks,
    db: Database = Depends(get_db),
    notifier: Notifier = Depends(get_notifier),
    now: datetime = Depends(get_now),
) -> dict[str, Any]:
    booking = await db.get_booking(booking_id)
    if booking is None or booking["status"] != "active":
        raise HTTPException(404, "Активная запись не найдена")
    if not is_upcoming(booking, now):
        raise HTTPException(409, "Запись уже прошла, отменить её нельзя")
    await db.cancel_booking(booking_id, by="master")
    booking = await db.get_booking(booking_id)
    background.add_task(notifier.booking_cancelled_by_master, booking)
    return with_phase([booking], now)[0]


@admin.get("/services")
async def admin_services(db: Database = Depends(get_db)) -> list[dict[str, Any]]:
    return await db.list_services()


@admin.post("/services", status_code=201)
async def admin_create_service(payload: ServiceIn, db: Database = Depends(get_db)) -> dict[str, Any]:
    payload.category = await canonical_category(db, payload.category)
    return await db.create_service(payload.model_dump())


@admin.put("/services/{service_id}")
async def admin_update_service(service_id: int, payload: ServiceIn, db: Database = Depends(get_db)) -> dict[str, Any]:
    payload.category = await canonical_category(db, payload.category, service_id)
    service = await db.update_service(service_id, payload.model_dump())
    if service is None:
        raise HTTPException(404, "Услуга не найдена")
    return service


@admin.delete("/services/{service_id}", status_code=204)
async def admin_delete_service(service_id: int, db: Database = Depends(get_db)) -> None:
    if not await db.delete_service(service_id):
        raise HTTPException(404, "Услуга не найдена")


async def work_days_json(db: Database, today: date) -> dict[str, Any]:
    return {day: work.model_dump() for day, work in (await db.list_work_days(today)).items()}


def schedule_json(schedule: ScheduleSettings, settings: Settings) -> dict[str, Any]:
    return {**schedule.model_dump(), "timezone": schedule.timezone or settings.timezone}


@admin.get("/schedule")
async def admin_schedule(
    db: Database = Depends(get_db), settings: Settings = Depends(get_settings), now: datetime = Depends(get_now)
) -> dict[str, Any]:
    today = now.date()
    return {
        "today": today.isoformat(),
        "schedule": schedule_json(await db.get_schedule(), settings),
        "days": await work_days_json(db, today),
        # Записи на дни календаря — их видно под календарём, если выбрать день
        "bookings": with_phase(await db.list_bookings(status="active", date_from=today), now),
    }


@admin.put("/schedule")
async def admin_save_schedule(
    payload: ScheduleSettings,
    request: Request,
    db: Database = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    # Без часового пояса в запросе оставляем тот, что был выбран раньше
    payload.timezone = payload.timezone or (await db.get_schedule()).timezone
    await db.save_schedule(payload)
    request.app.state.tz = master_tz(payload, settings)
    return schedule_json(payload, settings)


@admin.put("/days")
async def admin_set_work_days(
    payload: WorkDaysIn, db: Database = Depends(get_db), now: datetime = Depends(get_now)
) -> dict[str, Any]:
    today = now.date()
    last = today + timedelta(days=DAYS_AHEAD)
    if any(not today <= day <= last for day in payload.dates):
        raise HTTPException(400, "Менять можно дни с сегодняшнего и на год вперёд")
    await db.set_work_days(payload.dates, payload.day)
    return {"days": await work_days_json(db, today)}
