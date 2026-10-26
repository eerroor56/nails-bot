#!/usr/bin/env bash
# Обновляет бота до свежей версии из репозитория и перезапускает его.
#
#   sudo bash /opt/nails-bot/deploy/update.sh
#
# С вашего компьютера, без входа на сервер:
#   ssh root@<IP сервера> 'bash /opt/nails-bot/deploy/update.sh'
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/nails-bot}
APP_PORT=$(sed -n 's/^PORT=//p' /etc/nails-bot.env 2>/dev/null || true)
APP_PORT=${APP_PORT:-8080}

cd "$APP_DIR"
git pull --ff-only
"$APP_DIR/.venv/bin/pip" install -q -r requirements.txt
cp deploy/nails-bot.service /etc/systemd/system/nails-bot.service
systemctl daemon-reload
systemctl restart nails-bot

if curl -fsS --retry 10 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$APP_PORT/api/health" >/dev/null; then
  echo "Обновлено: $(git log -1 --format='%h %s')"
else
  echo "Бот не отвечает после обновления — смотрите логи: journalctl -u nails-bot -n 50" >&2
  exit 1
fi
