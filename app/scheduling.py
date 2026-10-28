"""Расписание мастера и расчёт свободных слотов. Только чистые функции — легко тестировать."""

from datetime import date, datetime, time, timedelta
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


def parse_hhmm(value: str) -> int:
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def fmt_hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


class DaySchedule(BaseModel):
    enabled: bool = True
    start: str = Field(default="10:00", pattern=TIME_PATTERN)
    end: str = Field(default="20:00", pattern=TIME_PATTERN)

    @model_validator(mode="after")
    def _check_range(self) -> "DaySchedule":
        if self.enabled and parse_hhmm(self.start) >= parse_hhmm(self.end):
            raise ValueError("Время начала работы должно быть раньше времени окончания")
        return self


def _default_week() -> list[DaySchedule]:
    weekdays = [DaySchedule() for _ in range(5)]
    return weekdays + [DaySchedule(start="10:00", end="18:00"), DaySchedule(enabled=False)]


class ScheduleSettings(BaseModel):
    slot_step: Literal[30, 60] = 30
    horizon_days: int = Field(default=30, ge=1, le=365)
    min_lead_minutes: int = Field(default=60, ge=0, le=7 * 24 * 60)
    # Понедельник = 0 ... воскресенье = 6
    week: list[DaySchedule] = Field(default_factory=_default_week)

    @field_validator("week")
    @classmethod
    def _seven_days(cls, value: list[DaySchedule]) -> list[DaySchedule]:
        if len(value) != 7:
            raise ValueError("Нужно расписание на 7 дней недели")
        return value


def working_hours(day: date, settings: ScheduleSettings, special: dict[str, DaySchedule]) -> tuple[int, int] | None:
    # День, настроенный в календаре, важнее обычной недели
    sched = special.get(day.isoformat(), settings.week[day.weekday()])
    if not sched.enabled:
        return None
    return parse_hhmm(sched.start), parse_hhmm(sched.end)


def bookable_range(settings: ScheduleSettings, now: datetime) -> tuple[date, date]:
    first = now.date()
    return first, first + timedelta(days=settings.horizon_days - 1)


def earliest_minute(day: date, settings: ScheduleSettings, now: datetime) -> int | None:
    """Самая ранняя минута дня, на которую ещё можно записаться (None — ограничений нет)."""
    earliest = now.replace(tzinfo=None) + timedelta(minutes=settings.min_lead_minutes)
    day_start = datetime.combine(day, time())
    if earliest <= day_start:
        return None
    return int((earliest - day_start).total_seconds() // 60) + (1 if earliest.second or earliest.microsecond else 0)


def free_slots(
    hours: tuple[int, int],
    step: int,
    duration: int,
    busy: list[tuple[int, int]],
    earliest: int | None = None,
) -> list[int]:
    """Начала слотов (в минутах от полуночи), куда помещается процедура длительностью duration."""
    work_start, work_end = hours
    duration = max(duration, 1)
    result = []
    start = work_start
    while start + duration <= work_end:
        end = start + duration
        if (earliest is None or start >= earliest) and not any(
            start < b_end and b_start < end for b_start, b_end in busy
        ):
            result.append(start)
        start += step
    return result


def day_slots(
    day: date,
    settings: ScheduleSettings,
    special: dict[str, DaySchedule],
    busy: list[tuple[int, int]],
    duration: int,
    now: datetime,
) -> list[int]:
    first, last = bookable_range(settings, now)
    if not first <= day <= last:
        return []
    hours = working_hours(day, settings, special)
    if hours is None:
        return []
    return free_slots(hours, settings.slot_step, duration, busy, earliest_minute(day, settings, now))
