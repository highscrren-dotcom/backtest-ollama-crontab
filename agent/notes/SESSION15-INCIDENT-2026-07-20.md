# Session 15 — инцидент, фикс сайзинга, первый боевой филл, орфан, ручная защита OCO

**Дата:** 2026-07-20 → 2026-07-21 (UTC). Форк: `backtest-ollama-crontab` (live-бот).
**Итог:** live остановлен для переноса на домашний сервер; открытая SOL-позиция
защищена биржевым OCO (независимым от бота).

---

## 1. Хронология (UTC)

| Время | Событие |
|---|---|
| ~08:00 | gramJS-краул канала завис (watchdog-таймауты live-fetch-data) — ДО рестарта |
| 08:28 | live рестартнут (предыдущей сессией) на 16.3.0, gramJS вылечен, пост 5741 заингещён |
| 08:45 | сигнал 5741 (SOL LONG 75.10–75.93) в окне → первая боевая попытка ордера → **reject: insufficient balance** |
| **09:07** | **live УМЕР** (telegram «Connection closed» → «Bot is offline»); у systemd-юнита не было `Restart=` → остался мёртвым |
| 09:07–13:28 | **live простоял ~4 часа**; duty-watch (2ч-крон) поймал (11:23, 13:23 red «live НЕ ЗАПУЩЕН», алерты в телегу ушли) |
| 13:28 | live поднят агентом (session 15) durable: `systemd-run --user` + **`Restart=always`**, RestartSec=15, StartLimit 6/600 |
| ~18:17 | новый пост 5742 (SOL LONG 76–78, цели 79.5/81/84/87/91, SL 73) |
| 18:3x | диагностика балансовых reject-ов: причина НЕ плечо, а фикс cost=$100 > баланс $96.5 |
| ~18:50 | деплой фикса сайзинга (рестарт live с правкой) |
| **18:51:58** | **ПЕРВЫЙ БОЕВОЙ ФИЛЛ: buy 1.2148 SOL @ 77.76** (сигнал 5742) |
| 18:5x | обнаружен орфан: бот позицию не зарегистрировал (signal-items=0), защиты нет |
| ~19:00 | выставлен ручной **OCO** (TP 79.5 / SL 73→72.5) на 1.214 SOL |
| 19:0x | live остановлен для переноса на домашний сервер |

---

## 2. Корневые причины

### 2.1. 4-часовой даунтайм live (09:07–13:28)
- НЕ OOM (память чистая). Node вышел на telegram-дисконнекте, а у транзиентного
  systemd-юнита `live-bot.service` **не было политики рестарта** → процесс остался
  мёртвым до ручного подъёма.
- **Фикс:** пересоздан с `Restart=always` RestartSec=15 StartLimit=6/600с. Теперь
  сетевой обрыв/краш бота → systemd сам поднимает.
- **Сессионные мониторы промахнулись:** фильтры были на gramJS-*ханг* (процесс
  жив-висит), а тут *чистая смерть* процесса — `tail -f` просто замолк. Добавлен
  poll-монитор здоровья (count≠1 / ingest-stale dead-man).

### 2.2. Reject «insufficient balance» — НЕ плечо, а фикс-$100
- Движок: `cost = signal.cost || CC_POSITION_ENTRY_COST`, где
  `CC_POSITION_ENTRY_COST = 100` (в `node_modules/backtest-kit/build/index.mjs:629`,
  не переопределён). `moonbag` свой cost не задаёт → каждый ордер = **фикс $100**.
- Плечо X10/X25 из текста сигнала движок **не использует вообще** (опасного ×плеча
  в сайзинге нет).
- На счету было **$96.5 USDT** → $100 не влезал → «insufficient balance» каждый тик
  (за день 133 reject-а; то же было на PENGU 16.07).

### 2.3. Орфан после первого филла (класс №88)
- Вход поставлен как **limit buy @ 77.76** (ниже рынка 77.79) → налился **пассивно
  позже** (18:51:58). `createLimitOrderAndWait` до филла бросил transient «не налит»
  → `onOrderOpenCommit` вышел без регистрации/брекетов.
- Reconcile-ветка (`attempt>0` → `fetchEntryByClientId`) поздно-налитый лимитник
  **не подхватила** → **signal-items=0, бот позицию не ведёт** (ни moonbag −1%, ни
  trailing). На ретраях бот спамил `Filter failure: NOTIONAL` (осталось $1.95 free).
- Это downstream-баг регистрации, **НЕ дефект сайзинг-фикса** (фикс отработал —
  ордер принят и налит).

---

## 3. Изменения в коде

**Файл:** `content/jan_2026.strategy/modules/live.module.ts`,
метод `SpotBrokerAdapter.onOrderOpenCommit`.
**Бэкап:** `agent/notes/sizing-fix-backup/live.module.ts.bak-20260720-184616`.

Было:
```ts
const qty = truncateQty(exchange, symbol, cost / priceOpen);
```
Стало (спот-сайзинг по кэшу — вариант владельца):
```ts
const quoteCcy: string = "USDT";
const freeUsdt      = parseFloat(String((await exchange.fetchBalance())?.free?.[quoteCcy] ?? 0));
const effectiveCost = Math.min(cost, freeUsdt * 0.98);   // ≤98% кэша, запас на комиссию
const minNotional   = exchange.markets[symbol]?.limits?.cost?.min ?? 1;
if (effectiveCost < minNotional) {
  throw new OrderRejectedError(`SpotBrokerAdapter: free USDT ... < minNotional ...`);
}
const qty = truncateQty(exchange, symbol, effectiveCost / priceOpen);
```
- Только LIVE (backtest/paper отсечены `payload.backtest`).
- tsc чист (`--noEmit --skipLibCheck`); loader — tsx (стрипает типы).
- НЕ закоммичено в git (ждёт «комить»).

---

## 4. Текущее состояние на момент остановки (19:03Z)

- **Позиция:** 1.214784 SOL (~$94), вход 77.76, PnL ≈ −0.26% (в ноль).
- **Защита — биржевой OCO** (orderListId **23539513475**, независим от бота):
  - TP: limit sell 1.214 SOL @ **$79.5** (+2.2%)
  - SL: stop-limit sell 1.214 SOL, триггер **$73.0** → лимит **$72.5** (−6.1%)
  - Сработает любая нога → вторая отменится автоматически.
  - **Оговорка:** SL это stop-LIMIT — гэп ниже $72.5 может не налить.
- **Балансы:** USDT free $1.95; пыль PENGU 0.07 / KITE 0.055 (<$1, до-существовали).
- **Остановка бота НЕ снимает OCO** — позиция защищена и без live-процесса.

---

## 5. Follow-ups (для переноса и после)

1. **Починить reconcile** поздно-налитого лимитника (иначе каждый реальный вход =
   орфан). Либо вход **market-buy при цене-в-окне** вместо limit-ниже-рынка (убирает
   задержку филла и орфан-риск).
2. **CC_POSITION_ENTRY_COST vs баланс** — держать баланс > номинала ИЛИ оставить
   спот-сайзинг по кэшу (внесён).
3. На новом сервере — **durable-юнит live с `Restart=always` + автостарт при буте**
   (сейчас у live НЕТ `@reboot`, в отличие от paper).
4. **duty-watch** после остановки будет слать «live НЕ ЗАПУЩЕН» каждые 2ч — на
   время переноса поставить на паузу (иначе ложные алерты).
5. Мониторить SOL-OCO: если TP/SL сработает — позиция закроется сама, вернётся USDT.

### Чек-лист переноса на домашний сервер (из памяти)
1. `curl https://api.binance.com/api/v3/ping` С СЕРВЕРА **до** переноса (РКН/VPN блокер).
2. Секреты `.env` перенести **отдельно** (не через git) + mongo-дамп + news-sqlite +
   crontab + systemd-юниты.
3. Cutover без двойного бота: стоп старый → `ps`=0 → старт новый (урок №98, ps надёжнее pgrep).
4. Поднять live как durable-юнит с `Restart=always` + автостарт при ребуте.
