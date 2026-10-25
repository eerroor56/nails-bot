"""Telegram-бот: /start с кнопкой Mini App, /admin для мастера, сохранение номера телефона."""

import logging

from aiogram import Bot, Dispatcher, F, Router
from aiogram.enums import ChatType
from aiogram.exceptions import TelegramAPIError
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    BotCommand,
    BotCommandScopeChat,
    BotCommandScopeDefault,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    MenuButtonWebApp,
    Message,
    WebAppInfo,
)

from .config import Settings
from .db import Database

log = logging.getLogger(__name__)

OPEN_APP_TEXT = "Открыть запись"


def webapp_keyboard(text: str, url: str) -> InlineKeyboardMarkup | None:
    # Telegram принимает в web_app только HTTPS-адреса
    if not url.startswith("https://"):
        return None
    return InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text=text, web_app=WebAppInfo(url=url))]])


async def cmd_start(message: Message, settings: Settings, db: Database) -> None:
    user = message.from_user
    if user:
        await db.upsert_user(
            user.id, first_name=user.first_name or "", last_name=user.last_name or "", username=user.username or ""
        )
    name = user.first_name if user else ""
    text = (
        f"Здравствуйте{', ' + name if name else ''}! 💅\n\n"
        f"Это онлайн-запись в «{settings.salon_name}». Выберите услугу, удобные дату и время — "
        "и запись готова за минуту.\n\n"
        f"Нажмите «{OPEN_APP_TEXT}», чтобы начать."
    )
    keyboard = None
    if message.chat.type == ChatType.PRIVATE:
        keyboard = webapp_keyboard(f"💅 {OPEN_APP_TEXT}", settings.webapp_url)
    await message.answer(text, reply_markup=keyboard)


async def cmd_admin(message: Message, settings: Settings) -> None:
    if not message.from_user or message.from_user.id not in settings.admin_ids:
        await message.answer("Эта команда доступна только мастеру.")
        return
    keyboard = webapp_keyboard("⚙️ Админ-панель", settings.admin_url) if message.chat.type == ChatType.PRIVATE else None
    if keyboard is None:
        await message.answer("Откройте админ-панель в личном чате с ботом (нужен HTTPS-адрес в WEBAPP_URL).")
        return
    await message.answer("Услуги, расписание и записи клиентов — в админ-панели:", reply_markup=keyboard)


async def cmd_id(message: Message) -> None:
    user_id = message.from_user.id if message.from_user else "—"
    await message.answer(f"Ваш ID: <code>{user_id}</code>\nID этого чата: <code>{message.chat.id}</code>")


async def on_contact(message: Message, db: Database) -> None:
    """Номер, которым клиент поделился из Mini App (requestContact), приходит боту обычным сообщением."""
    contact, user = message.contact, message.from_user
    if not user or contact.user_id != user.id:
        return
    phone = contact.phone_number if contact.phone_number.startswith("+") else f"+{contact.phone_number}"
    await db.upsert_user(
        user.id, first_name=user.first_name or "", last_name=user.last_name or "", username=user.username or "",
        phone=phone,
    )


def create_router() -> Router:
    router = Router(name="main")
    router.message.register(cmd_start, CommandStart())
    router.message.register(cmd_admin, Command("admin"))
    router.message.register(cmd_id, Command("id"))
    router.message.register(on_contact, F.contact)
    return router


def build_dispatcher(settings: Settings, db: Database) -> Dispatcher:
    dp = Dispatcher()
    # settings и db попадают в обработчики как аргументы
    dp["settings"] = settings
    dp["db"] = db
    dp.include_router(create_router())
    return dp


async def setup_bot(bot: Bot, settings: Settings) -> None:
    """Кнопка меню «Открыть запись» и список команд."""
    try:
        if settings.webapp_url.startswith("https://"):
            await bot.set_chat_menu_button(
                menu_button=MenuButtonWebApp(text=OPEN_APP_TEXT, web_app=WebAppInfo(url=settings.webapp_url))
            )
        else:
            log.warning("WEBAPP_URL должен начинаться с https:// — кнопка меню не установлена")
        base_commands = [BotCommand(command="start", description="Записаться на маникюр")]
        await bot.set_my_commands(base_commands, scope=BotCommandScopeDefault())
        admin_commands = base_commands + [
            BotCommand(command="admin", description="Админ-панель мастера"),
            BotCommand(command="id", description="Показать ID чата"),
        ]
        for admin_id in settings.admin_ids:
            try:
                await bot.set_my_commands(admin_commands, scope=BotCommandScopeChat(chat_id=admin_id))
            except TelegramAPIError as exc:
                # Мастер ещё не писал боту — команды появятся после перезапуска
                log.info("Не удалось задать команды для %s: %s", admin_id, exc)
    except TelegramAPIError as exc:
        log.warning("Не удалось настроить бота: %s", exc)
