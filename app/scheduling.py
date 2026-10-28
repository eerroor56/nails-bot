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


# На сколько дней вперёд мастер может расписать дни в календаре
DAYS_AHEAD = 365
# Сколько перерывов можно добавить в один день
MAX_BREAKS = 5


class Break(BaseModel):
    start: str = Field(pattern=TIME_PATTERN)
    end: str = Field(pattern=TIME_PATTERN)

    @model_validator(mode="after")
    def _check_range(self) -> "Break":
        if parse_hhmm(self.start) >= parse_hhmm(self.end):
            raise ValueError("У перерыва время начала должно быть раньше окончания")
        return self


class WorkDay(BaseModel):
    """Рабочий день из календаря мастера. Дней, которых нет в календаре, мастер не работает."""

    start: str = Field(default="10:00", pattern=TIME_PATTERN)
    end: str = Field(default="20:00", pattern=TIME_PATTERN)
    breaks: list[Break] = Field(default_factory=list, max_length=MAX_BREAKS)

    @model_validator(mode="after")
    def _check_range(self) -> "WorkDay":
        start, end = parse_hhmm(self.start), parse_hhmm(self.end)
        if start >= end:
            raise ValueError("Время начала работы должно быть раньше времени окончания")
        self.breaks = sorted(self.breaks, key=lambda b: parse_hhmm(b.start))
        previous = start
        for pause in self.breaks:
            if parse_hhmm(pause.start) < previous or parse_hhmm(pause.end) > end:
                raise ValueError("Перерывы должны быть внутри рабочего времени и не пересекаться")
            previous = parse_hhmm(pause.end)
        return self


class ScheduleSettings(BaseModel):
    slot_step: Literal[15, 30, 45, 60] = 30
    horizon_days: int = Field(default=30, ge=1, le=DAYS_AHEAD)
    min_lead_minutes: int = Field(default=60, ge=0, le=7 * 24 * 60)


def work_segments(day: WorkDay) -> list[tuple[int, int]]:
    """Рабочие отрезки дня между перерывами. После перерыва сетка времени начинается заново:
    мастер вернулся с обеда в 13:00 — значит, первое окно в 13:00, а не по сетке от начала дня."""
    segments, start = [], parse_hhmm(day.start)
    for pause in day.breaks:
        segments.append((start, parse_hhmm(pause.start)))
        start = parse_hhmm(pause.end)
    segments.append((start, parse_hhmm(day.end)))
    return [(seg_start, seg_end) for seg_start, seg_end in segments if seg_start < seg_end]


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
    work_days: dict[str, WorkDay],
    busy: list[tuple[int, int]],
    duration: int,
    now: datetime,
) -> list[int]:
    first, last = bookable_range(settings, now)
    work = work_days.get(day.isoformat())
    if work is None or not first <= day <= last:
        return []
    earliest = earliest_minute(day, settings, now)
    return [
        start
        for segment in work_segments(work)
        for start in free_slots(segment, settings.slot_step, duration, busy, earliest)
    ]
