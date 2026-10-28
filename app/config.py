"""Настройки приложения из переменных окружения (и файла .env)."""

import os
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
WEBAPP_DIR = BASE_DIR / "webapp"


def _int_list(raw: str) -> tuple[int, ...]:
    return tuple(int(x) for x in raw.replace(";", ",").split(",") if x.strip())


def _bool(raw: str | None, default: bool = False) -> bool:
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    bot_token: str = ""
    # Публичный HTTPS-адрес, по которому Telegram открывает Mini App
    webapp_url: str = ""
    admin_ids: tuple[int, ...] = ()
    # Куда слать уведомления о записях; если не задан — всем ADMIN_IDS
    master_chat_id: int | None = None
    timezone: str = "Europe/Moscow"
    database_path: Path = BASE_DIR / "data" / "nails.db"
    host: str = "0.0.0.0"
    port: int = 8080
    # polling | webhook | off
    bot_mode: str = "polling"
    webhook_secret: str = ""
    # Разрешает открывать приложение в обычном браузере без Telegram (только для разработки!)
    dev_mode: bool = False
    dev_user_id: int = 1
    salon_name: str = "Запись к мастеру"
    currency: str = "₽"
    # Сколько секунд считать initData действительной
    init_data_ttl: int = 24 * 60 * 60
    # Сколько будущих записей может одновременно иметь один клиент
    max_active_bookings: int = 3

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    @property
    def notify_chat_ids(self) -> tuple[int, ...]:
        if self.master_chat_id is not None:
            return (self.master_chat_id,)
        return self.admin_ids

    @property
    def admin_url(self) -> str:
        return self.webapp_url.rstrip("/") + "/admin.html" if self.webapp_url else ""

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv(BASE_DIR / ".env")
        env = os.environ.get
        admin_ids = _int_list(env("ADMIN_IDS", ""))
        master_chat = env("MASTER_CHAT_ID", "").strip()
        db_path = Path(env("DATABASE_PATH", "") or cls.database_path)
        if not db_path.is_absolute():
            db_path = BASE_DIR / db_path
        return cls(
            bot_token=env("BOT_TOKEN", "").strip(),
            webapp_url=env("WEBAPP_URL", "").strip().rstrip("/"),
            admin_ids=admin_ids,
            master_chat_id=int(master_chat) if master_chat else None,
            timezone=env("TIMEZONE", cls.timezone),
            database_path=db_path,
            host=env("HOST", cls.host),
            port=int(env("PORT", str(cls.port))),
            bot_mode=env("BOT_MODE", cls.bot_mode).strip().lower(),
            webhook_secret=env("WEBHOOK_SECRET", "").strip(),
            dev_mode=_bool(env("DEV_MODE")),
            dev_user_id=int(env("DEV_USER_ID", "") or (admin_ids[0] if admin_ids else 1)),
            salon_name=env("SALON_NAME", cls.salon_name),
            currency=env("CURRENCY", cls.currency),
            init_data_ttl=int(env("INIT_DATA_TTL", str(cls.init_data_ttl))),
            max_active_bookings=int(env("MAX_ACTIVE_BOOKINGS", str(cls.max_active_bookings))),
        )
