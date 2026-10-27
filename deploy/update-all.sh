#!/usr/bin/env bash
# Обновляет бота у всех мастеров по очереди и в конце показывает итог по каждому.
# Запускается на вашем компьютере (на Windows — в Git Bash), а не на сервере:
#
#   bash deploy/update-all.sh                  # список из masters.txt в текущей папке
#   bash deploy/update-all.sh ~/masters.txt
#
# В списке по одному серверу в строке: IP (или домен) и, по желанию, имя мастера одним словом.
# Пустые строки и всё после # пропускаются:
#
#   185.12.34.56  test    # свой тестовый бот — первым
#   185.12.34.78  anna
#
# На каждом сервере должен быть ваш SSH-ключ: пароль скрипт не спрашивает, такой сервер считается ошибкой.
# Сбой на одном сервере не останавливает остальные. Исключение — первый сервер в списке: если на нём
# не прошло само обновление, скорее всего, ошибка в новой версии, и скрипт останавливается,
# чтобы у остальных мастеров остался старый рабочий бот.
set -uo pipefail

list=${1:-masters.txt}
if [[ ! -f $list ]]; then
  echo "Нет файла со списком серверов: $list" >&2
  exit 2
fi

log=$(mktemp)
trap 'rm -f "$log"' EXIT

# Почему не удалось подключиться — по сообщению ssh, понятными словами
ssh_problem() {
  if grep -q 'Permission denied' "$log"; then
    echo "сервер не пустил: на нём нет вашего SSH-ключа"
  elif grep -qE 'REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed' "$log"; then
    echo "у сервера сменился ключ (переустановлен?): проверьте и выполните ssh-keygen -R $1"
  elif grep -q 'Could not resolve' "$log"; then
    echo "нет такого адреса: проверьте строку в списке"
  elif grep -qE 'timed out|Connection refused|No route to host' "$log"; then
    echo "сервер не отвечает: выключен или не оплачен"
  else
    echo "нет SSH-подключения: $(tail -n 1 "$log")"
  fi
}

ok=()
failed=()
stopped=""
while IFS= read -r line <&3; do
  line=${line%%#*}
  line=${line//$'\r'/}  # список, сохранённый в Блокноте, приходит с CRLF
  read -r host name _ <<<"$line"
  [[ -n ${host:-} ]] || continue
  label=$host
  [[ -n ${name:-} ]] && label="$name ($host)"

  echo
  echo "== $label"
  ssh -n -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    "root@$host" 'bash /opt/nails-bot/deploy/update.sh' 2>&1 | tee "$log"
  code=${PIPESTATUS[0]}
  sed -i 's/\r$//; /^[[:space:]]*$/d' "$log"

  if [[ $code -eq 0 ]]; then
    ok+=("$label — $(tail -n 1 "$log" | sed 's/^Обновлено: //')")
  elif [[ $code -eq 255 ]]; then
    failed+=("$label — $(ssh_problem "$host")")
  else
    failed+=("$label — $(tail -n 1 "$log")")
    if [[ $((${#ok[@]} + ${#failed[@]})) -eq 1 ]]; then
      stopped=$label
      break
    fi
  fi
done 3<"$list"

total=$((${#ok[@]} + ${#failed[@]}))
if [[ $total -eq 0 ]]; then
  echo "В $list нет ни одного сервера" >&2
  exit 2
fi

echo
echo "Итог: обновлено ${#ok[@]} из $total"
[[ ${#ok[@]} -eq 0 ]] || printf '  ✓ %s\n' "${ok[@]}"
[[ ${#failed[@]} -eq 0 ]] || printf '  ✗ %s\n' "${failed[@]}"
if [[ -n $stopped ]]; then
  echo
  echo "Остальные серверы не трогали: обновление не прошло на первом в списке — $stopped."
  echo "Скорее всего, ошибка в новой версии. Исправьте её и запустите скрипт снова."
fi
[[ ${#failed[@]} -eq 0 ]]
