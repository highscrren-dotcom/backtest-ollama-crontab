#!/usr/bin/env bash
# Запуск БОЕВОГО live-движка jan_2026 в контейнере (Coolify).
#
# Гейт: пока LIVE_ENABLED != 1 — движок НЕ стартует, контейнер «паркуется».
# Включение live = LIVE_ENABLED=1 в env аппа + рестарт. Осознанное решение владельца.
#
# Лог дублируется в logs/live-ingest.log: его грепают scripts/drift-alert.sh и
# вахта (свежесть тиков). touch paper-ingest.log — drift-alert делает `ls $LOGS ||
# exit 0` по обоим файлам и молча выходит, если какого-то нет.
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs dump
touch logs/live-ingest.log logs/paper-ingest.log

if [ "${LIVE_ENABLED:-0}" != "1" ]; then
  echo "[run-live] LIVE_ENABLED!=1 — движок не стартуем, контейнер в ожидании ($(date -Is))"
  exec sleep infinity
fi

# kill режет классификатор (известный квирк) — рестарты live только по runbook владельца.
# pkill-паттерн экранирован (урок: self-match).
term() { pkill -TERM -f "index[.]mjs --live" 2>/dev/null; }
trap term TERM INT

set -o pipefail
node ./node_modules/@backtest-kit/cli/build/index.mjs --live --noFlush --ui --telegram \
  --entry ./content/jan_2026.strategy/jan_2026.strategy.ts 2>&1 | tee -a logs/live-ingest.log
