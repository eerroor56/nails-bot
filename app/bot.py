"""Telegram-бот: /start с кнопкой Mini App, /admin для мастера, сохранение номера телефона.

Остальные сообщения в личке бот удаляет и отвечает подсказкой: запретить писать боту Telegram не позволяет,
а без ответа клиент думает, что пишет мастеру.
"""

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
HINT_TEXT = (
    "Здесь работает только онлайн-запись: сообщения в этот чат не доходят до мастера.\n\n"
    f"Чтобы записаться, посмотреть или отменить запись, нажмите «{OPEN_APP_TEXT}»."
)


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
        "Это онлайн-запись к мастеру. Выберите услугу, удобные дату и время — "
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


async def delete_quietly(bot: Bot, chat_id: int, message_id: int) -> None:
    try:
        await bot.delete_message(chat_id=chat_id, message_id=message_id)
    except TelegramAPIError as exc:
        # Уже удалено или старше 48 часов — тогда Telegram не даёт удалить
        log.debug("Не удалось удалить сообщение %s в чате %s: %s", message_id, chat_id, exc)


async def on_other_message(message: Message, bot: Bot, settings: Settings, hints: dict[int, int]) -> None:
    """Любое другое сообщение в личке: удаляем его и оставляем в чате одну подсказку с кнопкой записи."""
    await delete_quietly(bot, message.chat.id, message.message_id)
    previous = hints.pop(message.chat.id, None)
    if previous:
        await delete_quietly(bot, message.chat.id, previous)
    hint = await message.answer(HINT_TEXT, reply_markup=webapp_keyboard(f"💅 {OPEN_APP_TEXT}", settings.webapp_url))
    hints[message.chat.id] = hint.message_id


async def on_contact(message: Message, bot: Bot, settings: Settings, db: Database, hints: dict[int, int]) -> None:
    """Номер, которым клиент поделился из Mini App (requestContact), приходит боту обычным сообщением."""
    contact, user = message.contact, message.from_user
    if not user or contact.user_id != user.id:
        await on_other_message(message, bot, settings, hints)
        return
    phone = contact.phone_number if contact.phone_number.startswith("+") else f"+{contact.phone_number}"
    await db.upsert_user(
        user.id, first_name=user.first_name or "", last_name=user.last_name or "", username=user.username or "",
        phone=phone,
    )
    # Номер сохранён — убираем карточку контакта из переписки
    await delete_quietly(bot, message.chat.id, message.message_id)


def create_router() -> Router:
    router = Router(name="main")
    private = F.chat.type == ChatType.PRIVATE
    router.message.register(cmd_start, CommandStart())
    router.message.register(cmd_admin, Command("admin"))
    router.message.register(cmd_id, Command("id"))
    router.message.register(on_contact, F.contact, private)
    # Последним: всё, что не поймали обработчики выше. В группах сообщения не трогаем
    router.message.register(on_other_message, private)
    return router


def build_dispatcher(settings: Settings, db: Database) -> Dispatcher:
    dp = Dispatcher()
    # settings, db и hints попадают в обработчики как аргументы
    dp["settings"] = settings
    dp["db"] = db
    dp["hints"] = {}  # чат → id последней подсказки, чтобы она не копилась
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
