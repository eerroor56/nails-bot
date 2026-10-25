"""Тексты и отправка уведомлений клиенту и мастеру."""

import logging
from datetime import date
from html import escape
from typing import Any

from aiogram import Bot
from aiogram.exceptions import TelegramAPIError
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

from .config import Settings

log = logging.getLogger(__name__)

MONTHS_GENITIVE = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
]
WEEKDAYS_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]


def human_date(value: str | date) -> str:
    day = date.fromisoformat(value) if isinstance(value, str) else value
    return f"{day.day} {MONTHS_GENITIVE[day.month - 1]} {day.year} ({WEEKDAYS_SHORT[day.weekday()]})"


def human_slot(booking: dict[str, Any], with_end: bool = False) -> str:
    time_part = f"{booking['time']}–{booking['end_time']}" if with_end else booking["time"]
    return f"{human_date(booking['date'])}, {time_part}"


def human_price(amount: int, currency: str) -> str:
    return f"{amount:,}".replace(",", " ") + f" {currency}"


def human_duration(minutes: int) -> str:
    hours, mins = divmod(minutes, 60)
    parts = []
    if hours:
        parts.append(f"{hours} ч")
    if mins or not hours:
        parts.append(f"{mins} мин")
    return " ".join(parts)


def services_list(booking: dict[str, Any]) -> str:
    return ", ".join(escape(s["name"]) for s in booking["services"])


def client_link(booking: dict[str, Any]) -> str:
    name = f'<a href="tg://user?id={booking["user_id"]}">{escape(booking["client_name"])}</a>'
    if booking.get("username"):
        name += f" (@{escape(booking['username'])})"
    return name


def master_new_booking_text(booking: dict[str, Any], currency: str) -> str:
    return (
        "<b>Новая запись!</b>\n"
        f"Клиент: {client_link(booking)} / {escape(booking['phone'])}\n"
        f"Услуга: {services_list(booking)}\n"
        f"Дата и время: {human_slot(booking, with_end=True)}\n"
        f"Сумма: {human_price(booking['total_price'], currency)}"
    )


def client_booking_text(booking: dict[str, Any], currency: str) -> str:
    return (
        f"✅ Ваша запись на <b>{human_slot(booking)}</b> успешно оформлена!\n\n"
        f"Услуги: {services_list(booking)}\n"
        f"Длительность: {human_duration(booking['duration_min'])}\n"
        f"Сумма: {human_price(booking['total_price'], currency)}\n\n"
        "Если планы изменятся, отменить запись можно в приложении."
    )


def master_cancelled_text(booking: dict[str, Any], currency: str) -> str:
    return (
        "<b>Клиент отменил запись</b>\n"
        f"Клиент: {client_link(booking)} / {escape(booking['phone'])}\n"
        f"Услуга: {services_list(booking)}\n"
        f"Дата и время: {human_slot(booking, with_end=True)}\n"
        f"Сумма: {human_price(booking['total_price'], currency)}"
    )


def client_cancelled_by_master_text(booking: dict[str, Any]) -> str:
    return (
        f"❌ К сожалению, ваша запись на <b>{human_slot(booking)}</b> отменена мастером.\n"
        "Выберите, пожалуйста, другое время в приложении."
    )


class Notifier:
    def __init__(self, bot: Bot | None, settings: Settings):
        self.bot = bot
        self.settings = settings

    def _app_keyboard(self, text: str, url: str) -> InlineKeyboardMarkup | None:
        if not url.startswith("https://"):
            return None
        return InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text=text, web_app=WebAppInfo(url=url))]])

    async def send(self, chat_id: int, text: str, reply_markup: InlineKeyboardMarkup | None = None) -> bool:
        if self.bot is None:
            log.info("Бот не настроен, сообщение для %s не отправлено:\n%s", chat_id, text)
            return False
        try:
            await self.bot.send_message(chat_id, text, parse_mode="HTML", reply_markup=reply_markup)
            return True
        except TelegramAPIError as exc:
            log.warning("Не удалось отправить сообщение в чат %s: %s", chat_id, exc)
            return False

    async def notify_masters(self, text: str) -> None:
        if not self.settings.notify_chat_ids:
            log.warning("Не задан ни MASTER_CHAT_ID, ни ADMIN_IDS — мастер не получит уведомление")
        for chat_id in self.settings.notify_chat_ids:
            await self.send(chat_id, text)

    async def booking_created(self, booking: dict[str, Any]) -> None:
        currency = self.settings.currency
        await self.notify_masters(master_new_booking_text(booking, currency))
        await self.send(
            booking["user_id"],
            client_booking_text(booking, currency),
            self._app_keyboard("Мои записи", self.settings.webapp_url),
        )

    async def booking_cancelled_by_client(self, booking: dict[str, Any]) -> None:
        await self.notify_masters(master_cancelled_text(booking, self.settings.currency))

    async def booking_cancelled_by_master(self, booking: dict[str, Any]) -> None:
        await self.send(
            booking["user_id"],
            client_cancelled_by_master_text(booking),
            self._app_keyboard("Выбрать другое время", self.settings.webapp_url),
        )
