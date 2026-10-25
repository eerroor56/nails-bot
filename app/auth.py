"""Проверка подписи initData, которую Telegram передаёт в Mini App.

https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
"""

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl


class InitDataError(Exception):
    pass


@dataclass(frozen=True)
class TgUser:
    id: int
    first_name: str = ""
    last_name: str = ""
    username: str = ""
    is_dev: bool = False

    @property
    def full_name(self) -> str:
        return " ".join(p for p in (self.first_name, self.last_name) if p)


def _secret_key(bot_token: str) -> bytes:
    return hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()


def sign_init_data(fields: dict[str, str], bot_token: str) -> str:
    """Возвращает hash для набора полей. Используется в проверке и в тестах."""
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    return hmac.new(_secret_key(bot_token), data_check_string.encode(), hashlib.sha256).hexdigest()


def validate_init_data(init_data: str, bot_token: str, max_age: int | None = 86400) -> TgUser:
    if not bot_token:
        raise InitDataError("BOT_TOKEN не настроен на сервере")
    if not init_data:
        raise InitDataError("Пустые данные авторизации")

    fields = dict(parse_qsl(init_data, keep_blank_values=True, strict_parsing=False))
    received_hash = fields.pop("hash", "")
    if not received_hash:
        raise InitDataError("В данных нет подписи")
    if not hmac.compare_digest(sign_init_data(fields, bot_token), received_hash):
        raise InitDataError("Неверная подпись данных")

    if max_age:
        try:
            auth_date = int(fields.get("auth_date", "0"))
        except ValueError as exc:
            raise InitDataError("Некорректная дата авторизации") from exc
        if time.time() - auth_date > max_age:
            raise InitDataError("Сессия устарела, перезапустите приложение")

    try:
        user = json.loads(fields["user"])
        return TgUser(
            id=int(user["id"]),
            first_name=user.get("first_name", ""),
            last_name=user.get("last_name", ""),
            username=user.get("username", ""),
        )
    except (KeyError, ValueError, TypeError) as exc:
        raise InitDataError("В данных нет пользователя") from exc
