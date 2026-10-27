from datetime import datetime

import pytest
from aiogram import Bot
from aiogram.client.session.base import BaseSession
from aiogram.methods import DeleteMessage, GetMe, SendMessage, SetChatMenuButton
from aiogram.types import Chat, Contact, Message, Update, User

from app.bot import build_dispatcher, setup_bot
from app.config import Settings
from app.db import Database

ADMIN_ID = 100
CLIENT_ID = 555
OTHER_ID = 777


class MockedSession(BaseSession):
    """Сессия без сети: запоминает вызовы Bot API и отвечает правдоподобными объектами."""

    def __init__(self):
        super().__init__()
        self.requests = []

    async def make_request(self, bot, method, timeout=None):
        self.requests.append(method)
        if isinstance(method, SendMessage):
            return Message(
                message_id=len(self.requests),
                date=datetime.now(),
                chat=Chat(id=method.chat_id, type="private"),
                text=method.text,
            )
        if isinstance(method, GetMe):
            return User(id=42, is_bot=True, first_name="Nails", username="nails_test_bot")
        return True

    async def stream_content(self, *args, **kwargs):  # pragma: no cover - не используется
        yield b""

    async def close(self):
        pass

    def sent(self) -> list[SendMessage]:
        return [r for r in self.requests if isinstance(r, SendMessage)]

    def deleted(self) -> list[int]:
        return [r.message_id for r in self.requests if isinstance(r, DeleteMessage)]


@pytest.fixture
async def env():
    settings = Settings(
        bot_token="42:TEST",
        webapp_url="https://nails.example.com",
        admin_ids=(ADMIN_ID,),
        salon_name="Тестовая студия",
    )
    db = Database(":memory:")
    await db.connect()
    session = MockedSession()
    bot = Bot("42:TEST", session=session)
    yield settings, db, bot, session, build_dispatcher(settings, db)
    await db.close()


def message_update(
    user_id: int, text: str = None, contact: Contact = None, message_id: int = 1, chat_type: str = "private"
) -> Update:
    user = User(id=user_id, is_bot=False, first_name="Анна", username="anna")
    chat_id = user_id if chat_type == "private" else -1001
    return Update(
        update_id=1,
        message=Message(
            message_id=message_id,
            date=datetime.now(),
            chat=Chat(id=chat_id, type=chat_type),
            from_user=user,
            text=text,
            contact=contact,
        ),
    )


async def test_start_shows_open_app_button(env):
    settings, db, bot, session, dp = env
    await dp.feed_update(bot, message_update(CLIENT_ID, "/start"))

    [answer] = session.sent()
    assert "Здравствуйте, Анна!" in answer.text
    assert "онлайн-запись к мастеру" in answer.text
    button = answer.reply_markup.inline_keyboard[0][0]
    assert "Открыть запись" in button.text
    assert button.web_app.url == "https://nails.example.com"
    assert (await db.get_user(CLIENT_ID))["username"] == "anna"


async def test_admin_command(env):
    settings, db, bot, session, dp = env
    await dp.feed_update(bot, message_update(CLIENT_ID, "/admin"))
    await dp.feed_update(bot, message_update(ADMIN_ID, "/admin"))

    denied, allowed = session.sent()
    assert "только мастеру" in denied.text
    assert denied.reply_markup is None
    assert allowed.reply_markup.inline_keyboard[0][0].web_app.url == "https://nails.example.com/admin.html"


async def test_shared_contact_is_saved_and_removed_from_chat(env):
    settings, db, bot, session, dp = env
    contact = Contact(phone_number="79991234567", first_name="Анна", user_id=CLIENT_ID)
    await dp.feed_update(bot, message_update(CLIENT_ID, contact=contact, message_id=7))
    assert (await db.get_user(CLIENT_ID))["phone"] == "+79991234567"
    assert session.deleted() == [7]
    assert session.sent() == []  # клиент в этот момент в Mini App — подсказка не нужна

    # чужой контакт не сохраняем: удаляем и показываем подсказку, как для любого сообщения
    foreign = Contact(phone_number="70000000000", first_name="Кто-то", user_id=999)
    await dp.feed_update(bot, message_update(OTHER_ID, contact=foreign, message_id=8))
    assert await db.get_user(OTHER_ID) is None
    assert session.deleted() == [7, 8]
    assert "не доходят до мастера" in session.sent()[-1].text


async def test_other_messages_are_deleted_with_one_hint(env):
    settings, db, bot, session, dp = env
    await dp.feed_update(bot, message_update(CLIENT_ID, "Здравствуйте, можно на завтра?", message_id=10))

    assert session.deleted() == [10]
    [hint] = session.sent()
    assert "не доходят до мастера" in hint.text
    assert hint.reply_markup.inline_keyboard[0][0].web_app.url == "https://nails.example.com"
    first_hint_id = len(session.requests)  # MockedSession выдаёт id = номер запроса

    # следующее сообщение: прежняя подсказка удаляется, в чате остаётся одна новая
    await dp.feed_update(bot, message_update(CLIENT_ID, "/unknown", message_id=11))
    assert session.deleted() == [10, 11, first_hint_id]
    assert len(session.sent()) == 2


async def test_commands_and_group_messages_are_not_deleted(env):
    settings, db, bot, session, dp = env
    await dp.feed_update(bot, message_update(CLIENT_ID, "/start"))
    await dp.feed_update(bot, message_update(CLIENT_ID, "привет всем", chat_type="supergroup"))
    assert session.deleted() == []
    assert len(session.sent()) == 1  # только ответ на /start


async def test_setup_bot_sets_menu_button(env):
    settings, db, bot, session, dp = env
    await setup_bot(bot, settings)
    [menu] = [r for r in session.requests if isinstance(r, SetChatMenuButton)]
    assert menu.menu_button.text == "Открыть запись"
    assert menu.menu_button.web_app.url == "https://nails.example.com"


def test_webhook_endpoint(tmp_path):
    from fastapi.testclient import TestClient

    from app.main import WEBHOOK_PATH, create_app

    settings = Settings(
        bot_token="42:TEST",
        webapp_url="https://nails.example.com",
        bot_mode="webhook",
        webhook_secret="s3cret",
        database_path=tmp_path / "db.sqlite",
    )
    session = MockedSession()
    app = create_app(settings, bot=Bot("42:TEST", session=session), run_bot=False)
    update = message_update(CLIENT_ID, "/start").model_dump(mode="json", exclude_none=True)
    with TestClient(app) as client:
        assert client.post(WEBHOOK_PATH, json=update).status_code == 403
        response = client.post(WEBHOOK_PATH, json=update, headers={"X-Telegram-Bot-Api-Secret-Token": "s3cret"})
        assert response.status_code == 200
    [answer] = session.sent()
    assert "Открыть запись" in answer.reply_markup.inline_keyboard[0][0].text
