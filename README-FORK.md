# README-FORK — отличия форка highscrren-dotcom от upstream

> Upstream: [backtest-kit/backtest-ollama-crontab](https://github.com/backtest-kit/backtest-ollama-crontab).
> Роль в нашем стеке: **Telegram-ingest** — эталонный producer ParserItem-фида для
> pump-anomaly и стратегий backtest-kit (см. `paperhands/agent/notes/fork-map.md`).
> Ветка правок — `integration` (master = чистый upstream для ребейзов).

## Отличия от upstream

1. **Чужие Telegram-креды удалены** (`packages/{core,main}/src/config/params.ts`):
   апстрим хардкодил api_id/api_hash автора как fallback. Теперь `CC_TELEGRAM_API_ID`
   / `CC_TELEGRAM_API_HASH` обязательны в `.env` (получить: https://my.telegram.org);
   `getTelegram()` бросает понятную ошибку, если не заданы. ⚠️ Используй ОТДЕЛЬНЫЙ
   аккаунт — MTProto user-session несёт риск бана.
2. **Переключатель риск-гейта `CC_RISK_GATE`** (`SignalLogicService.ts`):
   - `llm` (дефолт) — как в апстриме: Ollama Cloud `gpt-oss:120b` исполняет правила
     промптом (нужен `CC_OLLAMA_TOKEN` подписки);
   - `rules` — те же ПРАВИЛА 1-3 детерминированно, без LLM (формулы идентичны
     закомментированной if-версии автора в `content/jan_2026.strategy/jan_2026.test.ts`);
     для воспроизводимых бэктестов и независимости live-очереди от аплинка Ollama;
   - `off` — пропускать всё без проверки.
3. **Redis-пароль из окружения** (`docker/redis/docker-compose.yaml`):
   `${CC_REDIS_PASSWORD:-mysecurepassword}` вместо хардкода.
4. **`scripts/export-parser-items.mjs`** — экспорт Mongo-коллекций в формат
   ParserItem pump-anomaly: `--screened` берёт только `riskAction=follow` из
   `screen-items`. Шов с нашим OOS-стендом (`paperhands/example/scripts/pump_bench/`).
5. **`.env.example`** дополнен всеми переменными (upstream перечислял не все).

## Запуск (кратко; полная схема — README.md апстрима)

```bash
npm install && npm run build:core && npm run build:main   # .env должен существовать (dotenv -e .env в build-скриптах)
docker compose -f docker/mongodb/docker-compose.yaml up -d
docker compose -f docker/redis/docker-compose.yaml up -d
cd packages/main && npm run auth    # QR-логин → session.txt → cp в content/<strategy>/
npm start -- --backtest --entry ./content/jan_2026.strategy/jan_2026.strategy.ts   # или --live --ui
```

## Что помнить (из разбора fork-map)

- «--live» здесь = **сигнальный контур без исполнения ордеров** (createOrder в
  exchange-схемах нет) — экзекьютор подключается отдельно (verbatim брокер-адаптеры
  в доках backtest-kit).
- Канал захардкожен: `crypto_yoda_channel` (`CryptoYodaScreenService.ts`). Новый
  канал = свой `*ScreenService` c `ParseFormat` + ветка в `CrawlerService.crawlRange`.
- Апстрим активно меняется (безымянные коммиты «inc») — синхронизация:
  `git fetch upstream && git rebase upstream/master` на ветке integration, конфликты
  наших правок точечные.
