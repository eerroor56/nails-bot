"""Сборка приложения: FastAPI (API + статика Mini App) и бот aiogram в одном процессе."""

import asyncio
import contextlib
import logging
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from aiogram import Bot
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import admin, master_tz, router
from .bot import build_dispatcher, setup_bot
from .config import WEBAPP_DIR, Settings
from .db import Database
from .notifications import Notifier

log = logging.getLogger(__name__)

WEBHOOK_PATH = "/tg/webhook"


def create_app(
    settings: Settings | None = None,
    *,
    bot: Bot | None = None,
    run_bot: bool = True,
    clock: Callable[[], datetime] | None = None,
) -> FastAPI:
    """
    bot     — готовый экземпляр бота (в тестах); по умолчанию создаётся из BOT_TOKEN.
    run_bot — запускать ли получение апдейтов (polling/webhook).
    clock   — источник текущего времени (в тестах фиксируется); в часовой пояс мастера его переводит API.
    """
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db = Database(settings.database_path)
        await db.connect()
        app.state.tz = master_tz(await db.get_schedule(), settings)

        own_bot = bot is None and bool(settings.bot_token)
        tg_bot = bot or (
            Bot(settings.bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML)) if own_bot else None
        )
        dp = build_dispatcher(settings, db)

        app.state.db = db
        app.state.bot = tg_bot
        app.state.dp = dp
        app.state.notifier = Notifier(tg_bot, settings)

        polling: asyncio.Task | None = None
        if tg_bot is not None and run_bot and settings.bot_mode != "off":
            await setup_bot(tg_bot, settings)
            if settings.bot_mode == "webhook":
                await tg_bot.set_webhook(
                    settings.webapp_url + WEBHOOK_PATH,
                    secret_token=settings.webhook_secret or None,
                    allowed_updates=dp.resolve_used_update_types(),
                )
                log.info("Бот работает через webhook %s", settings.webapp_url + WEBHOOK_PATH)
            else:
                await tg_bot.delete_webhook()
                polling = asyncio.create_task(
                    dp.start_polling(tg_bot, handle_signals=False, close_bot_session=False)
                )
                log.info("Бот запущен в режиме polling")
        elif tg_bot is None:
            log.warning("BOT_TOKEN не задан: бот не запущен, уведомления не отправляются")

        try:
            yield
        finally:
            if polling is not None:
                with contextlib.suppress(RuntimeError):
                    await dp.stop_polling()
                polling.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await polling
            if own_bot and tg_bot is not None:
                await tg_bot.session.close()
            await db.close()

    app = FastAPI(title="Booking bot", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.settings = settings
    app.state.clock = clock or (lambda: datetime.now(timezone.utc))
    app.state.tz = settings.tz
    app.state.booking_lock = asyncio.Lock()

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Отдаём одно понятное сообщение вместо списка ошибок pydantic
        error = exc.errors()[0] if exc.errors() else {}
        message = str(error.get("msg", "Проверьте введённые данные")).removeprefix("Value error, ")
        return JSONResponse({"detail": message}, status_code=422)

    @app.middleware("http")
    async def no_cache_static(request: Request, call_next):
        response = await call_next(request)
        # WebView Telegram агрессивно кэширует файлы — после обновления клиенты должны видеть новую версию
        if not request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.post(WEBHOOK_PATH, include_in_schema=False)
    async def telegram_webhook(request: Request) -> dict[str, bool]:
        if settings.bot_mode != "webhook" or app.state.bot is None:
            raise HTTPException(404)
        if settings.webhook_secret and request.headers.get("X-Telegram-Bot-Api-Secret-Token") != settings.webhook_secret:
            raise HTTPException(403)
        await app.state.dp.feed_webhook_update(app.state.bot, await request.json())
        return {"ok": True}

    @app.get("/api/health", include_in_schema=False)
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(router)
    app.include_router(admin)
    app.mount("/", StaticFiles(directory=WEBAPP_DIR, html=True), name="webapp")
    return app
