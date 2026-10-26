#!/usr/bin/env bash
# Ставит бота на чистый сервер мастера (Ubuntu 22.04 или 24.04): Python, веб-сервер Caddy с HTTPS,
# службу systemd и ночные резервные копии базы.
#
#   sudo bash /opt/nails-bot/deploy/install.sh <домен> <токен бота> <ID мастера> ["Название студии"]
#
# Пример:
#   sudo bash /opt/nails-bot/deploy/install.sh anna.example.ru 123456789:AAH... 987654321 "Студия Анны"
#
# Часовой пояс по умолчанию — Europe/Moscow. Другой: sudo TIMEZONE=Asia/Yekaterinburg bash ...
# Повторный запуск безопасен: файл настроек не перезаписывается, остальное обновляется.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/nails-bot}
ENV_FILE=${ENV_FILE:-/etc/nails-bot.env}
DATA_DIR=${DATA_DIR:-/var/lib/nails-bot}
CADDYFILE=${CADDYFILE:-/etc/caddy/Caddyfile}
UNIT_FILE=${UNIT_FILE:-/etc/systemd/system/nails-bot.service}
CRON_FILE=${CRON_FILE:-/etc/cron.d/nails-bot-backup}
APP_PORT=${APP_PORT:-8080}
# SKIP_SYSTEM=1 — только создать файлы, без apt, пользователей и служб (для проверки скрипта)
SKIP_SYSTEM=${SKIP_SYSTEM:-0}

die() {
  echo "Ошибка: $*" >&2
  exit 1
}

step() {
  echo
  echo "==> $*"
}

if [[ $# -lt 3 || $# -gt 4 ]]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

domain=$1
token=$2
admin_id=$3
salon=${4:-Маникюр}
timezone=${TIMEZONE:-Europe/Moscow}

[[ $SKIP_SYSTEM == 1 || $EUID -eq 0 ]] || die "запустите скрипт через sudo"
[[ $domain =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] || die "домен указан неверно: $domain"
[[ $token =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || die "это не похоже на токен бота от @BotFather"
[[ $admin_id =~ ^[0-9]+(,[0-9]+)*$ ]] || die "ID мастера — число (несколько — через запятую без пробелов)"
[[ $salon != *'"'* ]] || die "в названии студии не должно быть кавычек"
[[ -f $APP_DIR/app/__main__.py ]] || die "код бота не найден в $APP_DIR — сначала склонируйте репозиторий туда"
if [[ -e $ENV_FILE ]]; then
  # Повторный запуск: адрес в настройках и в Caddy должен совпадать, иначе Mini App перестанет открываться
  current_url=$(sed -n 's/^WEBAPP_URL=//p' "$ENV_FILE")
  [[ $current_url == "https://$domain" ]] ||
    die "в $ENV_FILE указан другой адрес: $current_url. Чтобы сменить домен, исправьте WEBAPP_URL в этом файле и запустите скрипт снова"
fi

if [[ $SKIP_SYSTEM != 1 ]]; then
  step "Устанавливаю пакеты"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q python3-venv curl gpg debian-keyring debian-archive-keyring apt-transport-https
  if ! command -v caddy >/dev/null 2>&1; then
    # Официальный репозиторий Caddy: https://caddyserver.com/docs/install#debian-ubuntu-raspbian
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
      gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
    apt-get install -y -q caddy
  fi

  step "Создаю пользователя и ставлю зависимости Python"
  id nails >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin nails
  python3 -m venv "$APP_DIR/.venv"
  "$APP_DIR/.venv/bin/pip" install -q --upgrade pip
  "$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
fi

step "Записываю настройки"
mkdir -p "$DATA_DIR" "$(dirname "$ENV_FILE")" "$(dirname "$CADDYFILE")" "$(dirname "$UNIT_FILE")" "$(dirname "$CRON_FILE")"
if [[ -e $ENV_FILE ]]; then
  echo "Файл настроек уже есть, оставляю как есть: $ENV_FILE"
else
  (
    umask 077 # в файле токен бота — читать его может только root
    cat >"$ENV_FILE" <<EOF
# $salon — установлено $(date '+%F %T')
BOT_TOKEN=$token
WEBAPP_URL=https://$domain
ADMIN_IDS=$admin_id
# ID группы для уведомлений о записях; пусто — уведомления получает мастер из ADMIN_IDS
MASTER_CHAT_ID=
TIMEZONE=$timezone
SALON_NAME="$salon"
DATABASE_PATH=$DATA_DIR/nails.db
HOST=127.0.0.1
PORT=$APP_PORT
BOT_MODE=polling
EOF
  )
fi
if id nails >/dev/null 2>&1; then
  chown nails: "$DATA_DIR"
fi

cp "$APP_DIR/deploy/nails-bot.service" "$UNIT_FILE"

cat >"$CADDYFILE" <<EOF
# Создано deploy/install.sh. Caddy сам получает и продлевает HTTPS-сертификат для домена.
$domain {
	encode gzip
	reverse_proxy 127.0.0.1:$APP_PORT
}
EOF

cat >"$CRON_FILE" <<EOF
# Резервная копия базы бота каждую ночь в 3:30
30 3 * * * root bash $APP_DIR/deploy/backup.sh >/dev/null 2>&1
EOF

if [[ $SKIP_SYSTEM == 1 ]]; then
  echo "SKIP_SYSTEM=1: файлы созданы, службы не запускались"
else
  step "Запускаю бота и веб-сервер"
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 80,443/tcp
  fi
  systemctl daemon-reload
  systemctl enable nails-bot
  systemctl restart nails-bot
  systemctl reload caddy 2>/dev/null || systemctl restart caddy

  step "Проверяю, что бот отвечает"
  if curl -fsS --retry 10 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$APP_PORT/api/health" >/dev/null; then
    echo "Бот запущен."
  else
    die "бот не отвечает — смотрите логи: journalctl -u nails-bot -n 50"
  fi
fi

cat <<EOF

Готово: «$salon»
  Mini App:   https://$domain  (первый HTTPS-сертификат выпускается до минуты)
  Настройки:  $ENV_FILE
  База:       $DATA_DIR/nails.db

Логи:       journalctl -u nails-bot -f
Обновление: sudo bash $APP_DIR/deploy/update.sh

Мастеру: нажать Start в своём боте, затем /admin — добавить услуги и проверить график.
EOF
