#!/usr/bin/env bash
# Дрейф-алерт шаблона канала: сигналоподобный пост («СИГНАЛ») с extracted:null
# в логе ingest = парсер перестал понимать формат (дрейфует ~ежемесячно, см.
# paperhands/agent/DECISIONS.md №22). Кроном раз в час; шумит только при РОСТЕ.
cd "$(dirname "$0")/.." || exit 1
# paper- и live-контуры пишут в разные логи; следим за обоими
LOGS="logs/paper-ingest.log logs/live-ingest.log"
STATE=logs/.drift-alert.count
ALERTS=logs/template-drift-alerts.log

ls $LOGS >/dev/null 2>&1 || exit 0
# «Parsed: { message: 'СИГНАЛ...' ... extracted: null» — многострочный блок
current=$(grep -h -A2 "message: 'СИГНАЛ" $LOGS 2>/dev/null | grep -c "extracted: null")
prev=$(cat "$STATE" 2>/dev/null || echo 0)

# лог обнулился (ротация/чистый рестарт) — сбрасываем базу без алерта
if [ "$current" -lt "$prev" ]; then prev=0; fi

if [ "$current" -gt "$prev" ]; then
  {
    echo "=== $(date -Is) ДРЕЙФ ШАБЛОНА: непарсящихся сигналов $prev → $current"
    grep -h -B1 -A2 "extracted: null" $LOGS 2>/dev/null | grep "message: 'СИГНАЛ" | tail -3
  } >> "$ALERTS"
fi
echo "$current" > "$STATE"
