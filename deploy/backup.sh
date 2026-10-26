#!/usr/bin/env bash
# Резервная копия базы бота. Безопасно запускать, пока бот работает.
# install.sh ставит её в cron каждую ночь; вручную:
#
#   sudo bash /opt/nails-bot/deploy/backup.sh
set -euo pipefail

DB_PATH=${DB_PATH:-/var/lib/nails-bot/nails.db}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/nails-bot}
KEEP_DAYS=${KEEP_DAYS:-30}
PYTHON=${PYTHON:-/opt/nails-bot/.venv/bin/python}

if [[ ! -e $DB_PATH ]]; then
  echo "Базы пока нет: $DB_PATH"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
target="$BACKUP_DIR/nails-$(date +%F).db"

# Встроенный backup SQLite даёт целостную копию даже во время записи
"$PYTHON" - "$DB_PATH" "$target" <<'EOF'
import sqlite3
import sys

source = sqlite3.connect(sys.argv[1])
target = sqlite3.connect(sys.argv[2])
source.backup(target)
target.close()
source.close()
EOF

# Старые копии удаляем, чтобы диск не заполнился
find "$BACKUP_DIR" -maxdepth 1 -name 'nails-*.db' -mtime +"$KEEP_DAYS" -delete

echo "Копия сохранена: $target"
