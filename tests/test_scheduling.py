from datetime import date, datetime

import pytest
from pydantic import ValidationError

from app.scheduling import DaySchedule, ScheduleSettings, day_slots, fmt_hhmm, free_slots, parse_hhmm

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


def test_day_slots_respects_lead_time_today():
    settings = ScheduleSettings(min_lead_minutes=120)  # сейчас 09:00 → не раньше 11:00
    slots = day_slots(NOW.date(), settings, set(), [], 60, NOW)
    assert hhmm(slots)[0] == "11:00"
    assert hhmm(slots)[-1] == "19:00"


def test_day_slots_day_off_weekend_and_horizon():
    settings = ScheduleSettings(horizon_days=7)
    assert day_slots(date(2026, 11, 1), settings, set(), [], 60, NOW) == []  # воскресенье — выходной
    assert day_slots(date(2026, 10, 27), settings, {"2026-10-27"}, [], 60, NOW) == []  # выходной по дате
    assert day_slots(date(2026, 11, 3), settings, set(), [], 60, NOW) == []  # за пределами 7 дней
    assert day_slots(date(2026, 10, 25), settings, set(), [], 60, NOW) == []  # прошлое
    assert day_slots(date(2026, 10, 31), settings, set(), [], 60, NOW)  # суббота — рабочая


def test_lead_time_crossing_midnight():
    late = datetime(2026, 10, 26, 23, 30, tzinfo=NOW.tzinfo)
    settings = ScheduleSettings(min_lead_minutes=12 * 60)  # не раньше 11:30 следующего дня
    slots = day_slots(date(2026, 10, 27), settings, set(), [], 30, late)
    assert hhmm(slots)[0] == "11:30"


def test_schedule_validation():
    with pytest.raises(ValidationError):
        DaySchedule(start="18:00", end="10:00")
    with pytest.raises(ValidationError):
        ScheduleSettings(slot_step=45)
    with pytest.raises(ValidationError):
        ScheduleSettings(week=[DaySchedule()] * 6)
    assert DaySchedule(enabled=False, start="18:00", end="10:00")  # выходной день не проверяется
