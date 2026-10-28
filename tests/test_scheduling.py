from datetime import date, datetime

import pytest
from pydantic import ValidationError

from app.scheduling import Break, ScheduleSettings, WorkDay, day_slots, fmt_hhmm, free_slots, parse_hhmm

from .conftest import NOW


def hhmm(slots):
    return [fmt_hhmm(s) for s in slots]


def test_parse_and_format():
    assert parse_hhmm("09:30") == 570
    assert fmt_hhmm(570) == "09:30"


def test_free_slots_step_30_fits_duration():
    slots = free_slots((parse_hhmm("10:00"), parse_hhmm("12:00")), 30, 60, [])
    assert hhmm(slots) == ["10:00", "10:30", "11:00"]


def test_free_slots_step_60():
    slots = free_slots((parse_hhmm("10:00"), parse_hhmm("13:00")), 60, 30, [])
    assert hhmm(slots) == ["10:00", "11:00", "12:00"]


def test_busy_interval_blocks_overlapping_slots():
    busy = [(parse_hhmm("11:00"), parse_hhmm("12:30"))]
    slots = free_slots((parse_hhmm("10:00"), parse_hhmm("14:00")), 30, 60, busy)
    # 10:30–11:30 пересекается с записью, 12:30 — уже свободно
    assert hhmm(slots) == ["10:00", "12:30", "13:00"]


def test_earliest_cuts_morning():
    slots = free_slots((parse_hhmm("10:00"), parse_hhmm("12:00")), 30, 30, [], earliest=parse_hhmm("10:45"))
    assert hhmm(slots) == ["11:00", "11:30"]


WEEKDAY = WorkDay(start="10:00", end="20:00")
# Понедельник 26.10 и вторник 27.10 — рабочие, остальных дней в календаре нет
DAYS = {"2026-10-26": WEEKDAY, "2026-10-27": WEEKDAY}


def test_day_slots_respects_lead_time_today():
    settings = ScheduleSettings(min_lead_minutes=120)  # сейчас 09:00 → не раньше 11:00
    slots = day_slots(NOW.date(), settings, DAYS, [], 60, NOW)
    assert hhmm(slots)[0] == "11:00"
    assert hhmm(slots)[-1] == "19:00"


def test_day_slots_day_off_and_horizon():
    settings = ScheduleSettings(horizon_days=7)
    assert day_slots(date(2026, 10, 28), settings, DAYS, [], 60, NOW) == []  # дня нет в календаре — выходной
    far = {"2026-11-03": WEEKDAY}
    assert day_slots(date(2026, 11, 3), settings, far, [], 60, NOW) == []  # за пределами 7 дней
    past = {"2026-10-25": WEEKDAY}
    assert day_slots(date(2026, 10, 25), settings, past, [], 60, NOW) == []  # прошлое
    assert day_slots(date(2026, 10, 27), settings, DAYS, [], 60, NOW)


def test_breaks_split_the_day():
    settings = ScheduleSettings(slot_step=45)
    lunch = {"2026-10-27": WorkDay(start="10:00", end="16:00", breaks=[Break(start="12:00", end="13:00")])}
    # До обеда по сетке 45 минут, после обеда сетка начинается с 13:00; через обед процедура не проходит
    assert hhmm(day_slots(date(2026, 10, 27), settings, lunch, [], 60, NOW)) == [
        "10:00", "10:45", "13:00", "13:45", "14:30",
    ]


def test_step_15():
    settings = ScheduleSettings(slot_step=15)
    short = {"2026-10-27": WorkDay(start="10:00", end="11:00")}
    assert hhmm(day_slots(date(2026, 10, 27), settings, short, [], 30, NOW)) == ["10:00", "10:15", "10:30"]


def test_lead_time_crossing_midnight():
    late = datetime(2026, 10, 26, 23, 30, tzinfo=NOW.tzinfo)
    settings = ScheduleSettings(min_lead_minutes=12 * 60)  # не раньше 11:30 следующего дня
    slots = day_slots(date(2026, 10, 27), settings, DAYS, [], 30, late)
    assert hhmm(slots)[0] == "11:30"


def test_schedule_validation():
    with pytest.raises(ValidationError):
        WorkDay(start="18:00", end="10:00")
    with pytest.raises(ValidationError):
        WorkDay(start="10:00", end="20:00", breaks=[Break(start="09:00", end="10:30")])  # раньше начала работы
    with pytest.raises(ValidationError):
        WorkDay(breaks=[Break(start="12:00", end="13:00"), Break(start="12:30", end="14:00")])  # пересекаются
    with pytest.raises(ValidationError):
        Break(start="13:00", end="12:00")
    with pytest.raises(ValidationError):
        ScheduleSettings(slot_step=20)
    day = WorkDay(breaks=[Break(start="15:00", end="15:30"), Break(start="12:00", end="13:00")])
    assert [b.start for b in day.breaks] == ["12:00", "15:00"]  # перерывы сортируются
