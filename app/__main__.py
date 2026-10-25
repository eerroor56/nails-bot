"""Запуск: python -m app"""

import logging
import sys

import uvicorn

from .config import Settings
from .main import create_app


def main() -> None:
    # На Windows при выводе в файл/канал Python по умолчанию пишет в cp1251 — русские логи превращаются в кракозябры
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings.from_env()
    if settings.dev_mode:
        logging.getLogger(__name__).warning(
            "DEV_MODE включён: API доступно без Telegram. Не используйте этот режим на боевом сервере!"
        )
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, proxy_headers=True)


if __name__ == "__main__":
    main()
