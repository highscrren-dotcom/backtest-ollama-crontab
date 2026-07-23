// Live-модуль jan_2026 (spot).
// Данные: дословно корневой modules/live.module.ts автора.
// Брокер: ДОСЛОВНЫЙ production-адаптер Binance Spot автора
// (_reference/backtest-kit-skills/source/configuration/broker-adapter.mdx, Tab "Spot"),
// портированный на API backtest-kit 15.2.0 (в доке — старый API).
// Отличия ТОЛЬКО ради совместимости:
//   1) onSignalOpenCommit → onOrderOpenCommit (type="schedule" — no-op: отложенный
//      вход отслеживает движок, реальный ордер ставится при активации type="active");
//   2) onSignalCloseCommit → onOrderCloseCommit;
//   3) guard payload.backtest → return (требование доки поля backtest в 15.2.0);
//   4) ccxt v4: 2-арг amountToPrecision (транкация — дефолт), типы Binance/Order.
// Тела хелперов и хуков — байт-в-байт авторские, своей логики нет.
import {
  addExchangeSchema,
  roundTicks,
  setConfig,
  Broker,
  OrderTransientError,
  OrderRejectedError,
} from "backtest-kit";
import type {
  IBroker,
  BrokerOrderOpenPayload,
  BrokerOrderClosePayload,
  BrokerPartialProfitPayload,
  BrokerPartialLossPayload,
  BrokerTrailingStopPayload,
  BrokerTrailingTakePayload,
  BrokerBreakevenPayload,
  BrokerAverageBuyPayload,
} from "backtest-kit";
import { singleshot, sleep } from "functools-kit";
import ccxt from "ccxt";

type Binance = InstanceType<typeof ccxt.binance>;
type Order = Awaited<ReturnType<Binance["fetchOpenOrders"]>>[number];

setConfig({
  CC_MAX_STOPLOSS_DISTANCE_PERCENT: 100,
  // Размер входа $20 (решение владельца 22.07, №112а): депозит ~$95 —
  // с дефолтными $100 сайзинг упирался в баланс (NOTIONAL/Insufficient, №111);
  // $20 = до 4 одновременных позиций + запас над биржевым минимумом $5.
  // ⚠️ Именно ЭТОТ модуль грузит CLI (--entry → chdir в папку стратегии);
  // корневой modules/live.module.ts рантаймом live НЕ используется.
  CC_POSITION_ENTRY_COST: 20,
});

// --- Данные: публичный spot-клиент (схема автора) ---

const getExchange = singleshot(async () => {
  const exchange = new ccxt.binance({
    options: {
      defaultType: "spot",
      adjustForTimeDifference: true,
      recvWindow: 60000,
    },
    enableRateLimit: true,
  });
  await exchange.loadMarkets();
  return exchange;
});

addExchangeSchema({
  exchangeName: "ccxt-exchange",
  getCandles: async (symbol, interval, since, limit) => {
    const exchange = await getExchange();
    const candles = await exchange.fetchOHLCV(
      symbol,
      interval,
      since.getTime(),
      limit,
    );
    return candles.map(([timestamp, open, high, low, close, volume]) => ({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    }));
  },
  getOrderBook: async (symbol, depth) => {
    const exchange = await getExchange();
    const bookData = await exchange.fetchOrderBook(symbol, depth);
    return {
      symbol,
      asks: bookData.asks.map(([price, quantity]) => ({
        price: String(price),
        quantity: String(quantity),
      })),
      bids: bookData.bids.map(([price, quantity]) => ({
        price: String(price),
        quantity: String(quantity),
      })),
    };
  },
  formatPrice: async (symbol, price) => {
    const exchange = await getExchange();
    const market = exchange.market(symbol);
    const tickSize = market.limits?.price?.min || market.precision?.price;
    if (tickSize !== undefined) {
      return roundTicks(price, tickSize);
    }
    return exchange.priceToPrecision(symbol, price);
  },
  formatQuantity: async (symbol, quantity) => {
    const exchange = await getExchange();
    const market = exchange.market(symbol);
    const stepSize = market.limits?.amount?.min || market.precision?.amount;
    if (stepSize !== undefined) {
      return roundTicks(quantity, stepSize);
    }
    return exchange.amountToPrecision(symbol, quantity);
  },
});

// --- Исполнение: авторский Binance Spot адаптер + retry-API 16.0.0 ---
// (ANSWER.md автора, agent/notes/author-answer-retry-api.md в paperhands):
// сеть → OrderTransientError (bounded retry с тем же signalId), отказ биржи
// навсегда → OrderRejectedError (дроп/force-close). Идемпотентность входа:
// clientOrderId = signalId; при attempt>0 СНАЧАЛА reconcile по origClientOrderId
// (duplicate-ловушка Binance не срабатывает для мгновенно исполненных ордеров —
// clientOrderId уникален только среди ОТКРЫТЫХ; сценарий №88/PENGU ловится
// именно предварительной сверкой).

const FILL_POLL_INTERVAL_MS = 10_000;
const FILL_POLL_ATTEMPTS = 10;
const CANCEL_SETTLE_MS = 2_000;
const STOP_LIMIT_SLIPPAGE = 0.995;
// Правило 3 из ANSWER.md Петра (23.07, №117): бюджет движка
// CC_ORDER_OPEN_RETRY_ATTEMPTS=5 → attempt 0..4; на attempt=4 — терминальный
// OrderRejectedError (движок потребляет signalId, переизданий больше нет).
const LAST_OPEN_ATTEMPT = 4;
// Правило «снять ВСЁ и выйти в кеш» на закрытии: заходы отмены (единичные
// отказы cancel терпимы — заход повторяется), затем проверка что стакан чист.
const CANCEL_ROUNDS = 10;

// Сетевой класс ccxt (RequestTimeout, ExchangeNotAvailable, DDoSProtection...)
// → transient; всё остальное от биржи (InsufficientFunds, InvalidOrder,
// BadSymbol -1121, min-notional...) → постоянный отказ. Нетипизированное
// (наши throw) движок сам трактует как transient — их не оборачиваем.
function toTypedError(e: unknown): Error {
  if (e instanceof ccxt.NetworkError) {
    return OrderTransientError.fromError(e as object);
  }
  if (e instanceof ccxt.ExchangeError) {
    return OrderRejectedError.fromError(e as object);
  }
  return e as Error;
}

// Binance: -2013 "Order does not exist" при запросе по origClientOrderId
function isOrderNotFound(e: unknown): boolean {
  return String((e as Error)?.message ?? "").includes("-2013");
}

// Сверка входа по clientOrderId=signalId: был ли прошлый POST исполнен.
// null = ордера с таким id нет (слать заново); иначе — сырой ответ Binance.
async function fetchEntryByClientId(
  exchange: Binance,
  symbol: string,
  signalId: string,
): Promise<{ status: string; executedQty: number; orderId: string } | null> {
  const market = exchange.market(symbol);
  try {
    const raw = await (exchange as any).privateGetOrder({
      symbol: market.id,
      origClientOrderId: signalId,
    });
    return {
      status: String(raw.status),
      executedQty: parseFloat(raw.executedQty ?? "0"),
      orderId: String(raw.orderId),
    };
  } catch (e) {
    if (isOrderNotFound(e)) return null;
    throw toTypedError(e);
  }
}

const getSpotExchange = singleshot(async () => {
  const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_API_SECRET,
    options: {
      defaultType: "spot",
      adjustForTimeDifference: true,
      recvWindow: 60000,
    },
    enableRateLimit: true,
  });
  await exchange.loadMarkets();
  return exchange;
});

function getBase(exchange: Binance, symbol: string): string {
  return exchange.markets[symbol].base;
}

function truncateQty(exchange: Binance, symbol: string, qty: number): number {
  // ccxt v4: amountToPrecision транкует по умолчанию (в доке автора — старый
  // 3-аргументный вызов с exchange.TRUNCATE, поведение идентично)
  return parseFloat(exchange.amountToPrecision(symbol, qty));
}

async function fetchFreeQty(exchange: Binance, symbol: string): Promise<number> {
  const balance = await exchange.fetchBalance();
  const base    = getBase(exchange, symbol);
  return parseFloat(String(balance?.free?.[base] ?? 0));
}

async function cancelAllOrders(exchange: Binance, orders: Order[], symbol: string): Promise<void> {
  await Promise.allSettled(orders.map((o) => exchange.cancelOrder(o.id, symbol)));
}

async function createStopLossOrder(
  exchange: Binance,
  symbol: string,
  qty: number,
  stopPrice: number
): Promise<void> {
  const limitPrice = parseFloat(exchange.priceToPrecision(symbol, stopPrice * STOP_LIMIT_SLIPPAGE));
  await exchange.createOrder(symbol, "stop_loss_limit", "sell", qty, limitPrice, { stopPrice });
}

// FIXME.md Петра (№117б), КОРЕНЬ каскада №114: на споте TP+SL на один объём —
// это ОДИН OCO-ордер (одна заморозка средств), а не два независимых sell.
// Раньше TP замораживал монеты → SL падал InsufficientFunds → аварийный
// market-sell падал о ту же заморозку → сырой throw = вечный транзиент.
async function placeOcoBrackets(
  exchange: Binance,
  symbol: string,
  qty: number,
  tpPrice: number,
  slPrice: number,
): Promise<void> {
  const market = exchange.market(symbol);
  await (exchange as any).privatePostOrderOco({
    symbol: market.id,
    side: "SELL",
    quantity: exchange.amountToPrecision(symbol, qty),
    price: exchange.priceToPrecision(symbol, tpPrice),
    stopPrice: exchange.priceToPrecision(symbol, slPrice),
    stopLimitPrice: exchange.priceToPrecision(symbol, slPrice * STOP_LIMIT_SLIPPAGE),
    stopLimitTimeInForce: "GTC",
  });
}

// TODO 5 FIXME: отмена с верификацией — повторять до пустого fetchOpenOrders
// (allSettled глотает единичные отказы; продавать можно только разморозив всё).
async function cancelAllVerified(exchange: Binance, symbol: string): Promise<void> {
  let lastErr: unknown = null;
  for (let round = 0; round < CANCEL_ROUNDS; round++) {
    const open = await exchange.fetchOpenOrders(symbol);
    if (open.length === 0) return;
    await cancelAllOrders(exchange, open, symbol);
    await sleep(CANCEL_SETTLE_MS);
    const left = await exchange.fetchOpenOrders(symbol);
    if (left.length === 0) return;
    lastErr = new Error(`Orders not canceled for ${symbol}: ${left.length} left (round ${round + 1})`);
  }
  if (lastErr) throw lastErr;
}

async function createLimitOrderAndWait(
  exchange: Binance,
  symbol: string,
  side: "buy" | "sell",
  qty: number,
  price: number,
  restore?: { tpPrice: number; slPrice: number },
  clientOrderId?: string,
): Promise<void> {
  const order = await exchange.createOrder(
    symbol, "limit", side, qty, price,
    clientOrderId ? { clientOrderId } : {},
  );

  // ANSWER.md Петра (правило 1): транзиентный throw НЕ имеет права оставить
  // живой ордер на бирже. Любая ошибка поллинга/отмены (сеть в fetchOrder,
  // гонка «исполнился во время cancel») раньше улетала наверх БЕЗ cancel —
  // лимитник жил в стакане и исполнялся сам через минуты (каскад №114).
  // Теперь: ошибка внутри → best-effort cancel → сверка статуса → rethrow.
  try {
    for (let i = 0; i < FILL_POLL_ATTEMPTS; i++) {
      await sleep(FILL_POLL_INTERVAL_MS);
      const status = await exchange.fetchOrder(order.id, symbol);
      if (status.status === "closed") return;
    }
    await exchange.cancelOrder(order.id, symbol);
  } catch (pollErr) {
    try {
      await exchange.cancelOrder(order.id, symbol);
    } catch {
      // cancel мог упасть потому, что ордер УЖЕ исполнился — сверяем
    }
    const check = await exchange.fetchOrder(order.id, symbol).catch(() => null);
    if (check?.status === "closed") return; // филл настиг во время ошибки — вход подтверждён
    if (check && check.status === "open") {
      // снять не смогли, ордер жив — это НЕ транзиент, оставлять нельзя:
      // ещё одна попытка отмены; если и она мимо — пусть ретрай упрётся в
      // reconcile по clientOrderId (живой NEW теперь обрабатывается там)
      await exchange.cancelOrder(order.id, symbol).catch(() => undefined);
    }
    throw toTypedError(pollErr);
  }
  await sleep(CANCEL_SETTLE_MS);

  const final     = await exchange.fetchOrder(order.id, symbol);
  const filledQty = final.filled ?? 0;

  if (final.status === "closed") return; // исполнился в окне cancel — вход состоялся

  if (filledQty > 0) {
    const rollbackSide = side === "buy" ? "sell" : "buy";
    await exchange.createOrder(symbol, "market", rollbackSide, filledQty);
  }

  if (restore) {
    const remainingQty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));
    if (remainingQty > 0) {
      // №117б: восстановление брекетов — тоже атомарный OCO (та же мина
      // «TP заморозил → SL упал» жила и здесь)
      await placeOcoBrackets(exchange, symbol, remainingQty, restore.tpPrice, restore.slPrice);
    }
  }

  throw new Error(`Limit order [${side} ${qty} ${symbol} @ ${price}] not filled — backtest-kit will retry`);
}

Broker.useBrokerAdapter(
  class implements Partial<IBroker> {
    async waitForInit(): Promise<void> {
      await getSpotExchange();
    }

    async onOrderOpenCommit(payload: BrokerOrderOpenPayload): Promise<void> {
      if (payload.backtest) return;
      if (payload.type === "schedule") return;
      const { symbol, signalId, cost, priceOpen, priceTakeProfit, priceStopLoss, position, attempt } = payload;

      if (position === "short") {
        // бизнес-отказ навсегда: спот шортов не знает — дроп без ретраев
        throw new OrderRejectedError(`SpotBrokerAdapter: short position is not supported on spot (symbol=${symbol})`);
      }

      const exchange = await getSpotExchange();

      // СПОТ-САЙЗИНГ ПО КЭШУ (владелец 20.07): на споте плеча нет и купить можно
      // только на живой USDT. Движок даёт номинальный cost (CC_POSITION_ENTRY_COST
      // $100 по умолчанию, moonbag свой cost не задаёт) — если он больше кэша,
      // Binance режет "insufficient balance". Берём min(номинал, 98% свободного
      // USDT) — запас 2% на комиссию/округление. backtest/paper сюда не заходят
      // (payload.backtest отсечён в начале onOrderOpenCommit).
      const quoteCcy: string = "USDT";
      const freeUsdt      = parseFloat(String((await exchange.fetchBalance())?.free?.[quoteCcy] ?? 0));
      const effectiveCost = Math.min(cost, freeUsdt * 0.98);
      const minNotional   = exchange.markets[symbol]?.limits?.cost?.min ?? 1;
      if (effectiveCost < minNotional) {
        // кэша меньше минимального нотионала биржи — торговать нечем; постоянный
        // дроп без ретраев (OrderRejectedError), чтобы не спамить каждую минуту.
        throw new OrderRejectedError(
          `SpotBrokerAdapter: free USDT ${freeUsdt.toFixed(2)} → cost ${effectiveCost.toFixed(2)} < minNotional ${minNotional} (${symbol}) — вход пропущен`,
        );
      }
      const qty = truncateQty(exchange, symbol, effectiveCost / priceOpen);

      if (qty <= 0) {
        throw new OrderRejectedError(`Computed qty is zero for ${symbol} — cost=${effectiveCost}, price=${priceOpen}`);
      }

      const openPrice = parseFloat(exchange.priceToPrecision(symbol, priceOpen));
      const tpPrice   = parseFloat(exchange.priceToPrecision(symbol, priceTakeProfit));
      const slPrice   = parseFloat(exchange.priceToPrecision(symbol, priceStopLoss));

      // TODO 2 FIXME: раскрутка = СНАЧАЛА cancel всего, что заморозило монеты,
      // ПОТОМ market-sell по факту свободного остатка; типизация ИСХОДНОЙ
      // ошибки доходит до движка всегда (раньше сырой InsufficientFunds из
      // раскрутки демотировал постоянный отказ в вечный транзиент).
      const unwindPosition = async (unwQty: number, originalErr: unknown): Promise<never> => {
        try {
          const open = await exchange.fetchOpenOrders(symbol);
          await cancelAllOrders(exchange, open, symbol);
          await sleep(CANCEL_SETTLE_MS);
          const freeQty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));
          if (freeQty > 0) {
            await exchange.createOrder(symbol, "market", "sell", Math.min(freeQty, unwQty));
          }
        } catch {
          // раскрутка не удалась — позицию выводит оператор; исходная ошибка важнее
        }
        throw toTypedError(originalErr);
      };

      const placeBrackets = async (bracketQty: number): Promise<void> => {
        try {
          await placeOcoBrackets(exchange, symbol, bracketQty, tpPrice, slPrice);
        } catch (err) {
          await unwindPosition(bracketQty, err);
        }
      };

      try {
        // TODO 3 FIXME (№117б): сверка по clientOrderId БЕЗУСЛОВНА, не только
        // при attempt>0 — после дропа ретрай-слота consumption-ревалидацией
        // свежая строка приходит с attempt=0 и ТЕМ ЖЕ id, а clientOrderId
        // исполненного ордера Binance переиспользует (дубль-гард только среди
        // ОТКРЫТЫХ). Гейт по attempt и превращал один сбой брекетов в
        // лестницу покупок (№114). Цена сверки для нового id — один вызов
        // (-2013 → null → слать заново).
        const prior = await fetchEntryByClientId(exchange, symbol, signalId);
        if (prior && prior.executedQty > 0) {
          const bracketQty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));
          if (bracketQty > 0) await placeBrackets(bracketQty);
          return; // вход уже куплен прошлой попыткой — покупку НЕ повторяем
        }
        if (prior && prior.status === "NEW") {
          // живой resting-ордер — ждём ЕГО, а не постим дубль (-2010)
          throw OrderTransientError.fromError(
            new Error(`entry ${signalId} still resting — waiting`),
          );
        }
        await createLimitOrderAndWait(exchange, symbol, "buy", qty, openPrice, undefined, signalId);
      } catch (err) {
        // Правило 3 ANSWER.md: бюджет движка исчерпан (attempt 0..4) —
        // снять свой resting-ордер, если остался, и отказаться ТЕРМИНАЛЬНО:
        // OrderRejectedError потребляет id, сигнал больше не переиздаётся.
        if (attempt >= LAST_OPEN_ATTEMPT) {
          const leftover = await fetchEntryByClientId(exchange, symbol, signalId).catch(() => null);
          if (leftover && (leftover.status === "NEW" || leftover.status === "PARTIALLY_FILLED")) {
            await exchange.cancelOrder(leftover.orderId, symbol).catch(() => undefined);
          }
          throw new OrderRejectedError(
            `entry ${signalId} not filled after ${attempt + 1} attempts — giving up`,
          );
        }
        throw toTypedError(err);
      }

      await placeBrackets(qty);
    }

    async onOrderCloseCommit(payload: BrokerOrderClosePayload): Promise<void> {
      if (payload.backtest) return;
      const { symbol, currentPrice, priceTakeProfit, priceStopLoss } = payload;
      const exchange = await getSpotExchange();

      try {
        // Шаги 1-2 ANSWER.md: снять ВСЕ ордера символа с повторами и убедиться,
        // что стакан по символу чист (включая артефакты прошлых попыток и TP
        // траншей-сирот) — только потом выходить в кеш.
        await cancelAllVerified(exchange, symbol); // throw = транзиент, движок ретраит close

        const qty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));
        if (qty === 0) return;

        const closePrice = parseFloat(exchange.priceToPrecision(symbol, currentPrice));
        const tpPrice    = parseFloat(exchange.priceToPrecision(symbol, priceTakeProfit));
        const slPrice    = parseFloat(exchange.priceToPrecision(symbol, priceStopLoss));

        await createLimitOrderAndWait(exchange, symbol, "sell", qty, closePrice, { tpPrice, slPrice });
      } catch (err) {
        // сеть → transient (ретрай следующим тиком, bounded CC_ORDER_CLOSE_RETRY_ATTEMPTS,
        // затем force-close движка — реальную позицию выводит оператор/дежурство);
        // отказ биржи → rejected (force-close сразу, наш кейс «продавца нет»)
        throw toTypedError(err);
      }
    }

    async onPartialProfitCommit(payload: BrokerPartialProfitPayload): Promise<void> {
      if (payload.backtest) return;
      const { symbol, percentToClose, currentPrice, priceTakeProfit, priceStopLoss } = payload;
      const exchange = await getSpotExchange();

      await cancelAllVerified(exchange, symbol); // №117б: продавать/докупать только разморозив всё

      const totalQty = await fetchFreeQty(exchange, symbol);
      if (totalQty === 0) {
        throw new Error(`PartialProfit skipped: no open position for ${symbol}`);
      }

      const qty          = truncateQty(exchange, symbol, totalQty * (percentToClose / 100));
      const remainingQty = truncateQty(exchange, symbol, totalQty - qty);
      const closePrice   = parseFloat(exchange.priceToPrecision(symbol, currentPrice));
      const tpPrice      = parseFloat(exchange.priceToPrecision(symbol, priceTakeProfit));
      const slPrice      = parseFloat(exchange.priceToPrecision(symbol, priceStopLoss));

      await createLimitOrderAndWait(exchange, symbol, "sell", qty, closePrice, { tpPrice, slPrice });

      if (remainingQty > 0) {
        try {
          await placeOcoBrackets(exchange, symbol, remainingQty, tpPrice, slPrice); // №117б
        } catch (err) {
          await exchange.createOrder(symbol, "market", "sell", remainingQty);
          throw err;
        }
      }
    }

    async onPartialLossCommit(payload: BrokerPartialLossPayload): Promise<void> {
      if (payload.backtest) return;
      const { symbol, percentToClose, currentPrice, priceTakeProfit, priceStopLoss } = payload;
      const exchange = await getSpotExchange();

      await cancelAllVerified(exchange, symbol); // №117б: продавать/докупать только разморозив всё

      const totalQty = await fetchFreeQty(exchange, symbol);
      if (totalQty === 0) {
        throw new Error(`PartialLoss skipped: no open position for ${symbol}`);
      }

      const qty          = truncateQty(exchange, symbol, totalQty * (percentToClose / 100));
      const remainingQty = truncateQty(exchange, symbol, totalQty - qty);
      const closePrice   = parseFloat(exchange.priceToPrecision(symbol, currentPrice));
      const tpPrice      = parseFloat(exchange.priceToPrecision(symbol, priceTakeProfit));
      const slPrice      = parseFloat(exchange.priceToPrecision(symbol, priceStopLoss));

      await createLimitOrderAndWait(exchange, symbol, "sell", qty, closePrice, { tpPrice, slPrice });

      if (remainingQty > 0) {
        try {
          await placeOcoBrackets(exchange, symbol, remainingQty, tpPrice, slPrice); // №117б
        } catch (err) {
          await exchange.createOrder(symbol, "market", "sell", remainingQty);
          throw err;
        }
      }
    }

    async onTrailingStopCommit(payload: BrokerTrailingStopPayload): Promise<void> {
      if (payload.backtest) return;
      const { symbol, newStopLossPrice } = payload;
      const exchange = await getSpotExchange();

      // №117б: брекеты теперь OCO — отмена одной ноги гасит обе, поэтому
      // запоминаем цену TP-ноги, сносим всё верифицированно и пересобираем пару.
      const orders  = await exchange.fetchOpenOrders(symbol);
      const tpLeg   = orders.find((o) => o.side === "sell" && ["limit", "LIMIT"].includes(o.type ?? "")) ?? null;
      await cancelAllVerified(exchange, symbol);

      const qty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));
      if (qty === 0) {
        throw new Error(`TrailingStop skipped: no open position for ${symbol}`);
      }

      const slPrice = parseFloat(exchange.priceToPrecision(symbol, newStopLossPrice));
      if (tpLeg?.price) {
        await placeOcoBrackets(exchange, symbol, qty, Number(tpLeg.price), slPrice);
      } else {
        await createStopLossOrder(exchange, symbol, qty, slPrice);
      }
    }

    async onTrailingTakeCommit(payload: BrokerTrailingTakePayload): Promise<void> {
      if (payload.backtest) return;
      const { symbol, newTakeProfitPrice } = payload;
      const exchange = await getSpotExchange();

      // №117б: OCO-пересборка — запоминаем стоп-ногу, сносим всё, ставим пару заново.
      const orders  = await exchange.fetchOpenOrders(symbol);
      const slLeg   = orders.find((o) =>
        o.side === "sell" &&
        ["stop_loss_limit", "stop", "STOP_LOSS_LIMIT"].includes(o.type ?? "")
      ) ?? null;
      const slTrigger = Number((slLeg as any)?.stopPrice ?? (slLeg as any)?.triggerPrice ?? 0);
      await cancelAllVerified(exchange, symbol);

      const qty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));
      if (qty === 0) {
        throw new Error(`TrailingTake skipped: no open position for ${symbol}`);
      }

      const tpPrice = parseFloat(exchange.priceToPrecision(symbol, newTakeProfitPrice));
      if (slTrigger > 0) {
        await placeOcoBrackets(exchange, symbol, qty, tpPrice, slTrigger);
      } else {
        await exchange.createOrder(symbol, "limit", "sell", qty, tpPrice);
      }
    }

    async onBreakevenCommit(payload: BrokerBreakevenPayload): Promise<void> {
      if (payload.backtest) return;
      const { symbol, newStopLossPrice } = payload;
      const exchange = await getSpotExchange();

      // №117б: OCO-пересборка (см. onTrailingStopCommit).
      const orders  = await exchange.fetchOpenOrders(symbol);
      const tpLeg   = orders.find((o) => o.side === "sell" && ["limit", "LIMIT"].includes(o.type ?? "")) ?? null;
      await cancelAllVerified(exchange, symbol);

      const qty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));
      if (qty === 0) {
        throw new Error(`Breakeven skipped: no open position for ${symbol}`);
      }

      const slPrice = parseFloat(exchange.priceToPrecision(symbol, newStopLossPrice));
      if (tpLeg?.price) {
        await placeOcoBrackets(exchange, symbol, qty, Number(tpLeg.price), slPrice);
      } else {
        await createStopLossOrder(exchange, symbol, qty, slPrice);
      }
    }

    async onAverageBuyCommit(payload: BrokerAverageBuyPayload): Promise<void> {
      if (payload.backtest) return;
      const { symbol, currentPrice, cost, priceTakeProfit, priceStopLoss } = payload;
      const exchange = await getSpotExchange();

      await cancelAllVerified(exchange, symbol); // №117б: продавать/докупать только разморозив всё

      const existing    = await fetchFreeQty(exchange, symbol);
      const minNotional = exchange.markets[symbol].limits?.cost?.min ?? 1;

      if (existing * currentPrice < minNotional) {
        throw new Error(`AverageBuy skipped: no open position for ${symbol}`);
      }

      const qty = truncateQty(exchange, symbol, cost / currentPrice);
      if (qty <= 0) {
        throw new Error(`Computed qty is zero for ${symbol} — cost=${cost}, price=${currentPrice}`);
      }

      const entryPrice = parseFloat(exchange.priceToPrecision(symbol, currentPrice));
      const tpPrice    = parseFloat(exchange.priceToPrecision(symbol, priceTakeProfit));
      const slPrice    = parseFloat(exchange.priceToPrecision(symbol, priceStopLoss));

      await createLimitOrderAndWait(exchange, symbol, "buy", qty, entryPrice, { tpPrice, slPrice });

      const totalQty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));

      try {
        await placeOcoBrackets(exchange, symbol, totalQty, tpPrice, slPrice); // №117б
      } catch (err) {
        await exchange.createOrder(symbol, "market", "sell", totalQty);
        throw err;
      }
    }
  }
);

Broker.enable();
// listenExit НЕ вайрим: @backtest-kit/cli сам дропает процесс на exitEmitter
// (cli/src/config/setup.ts:46, поправка автора 17.07) — systemd перезапустит.
