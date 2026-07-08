// Live-модуль jan_2026 (spot).
// Данные: дословно корневой modules/live.module.ts автора.
// Брокер: ДОСЛОВНЫЙ production-адаптер Binance Spot автора
// (_reference/backtest-kit-skills/source/configuration/broker-adapter.mdx, Tab "Spot"),
// портированный на API backtest-kit 15.2.0. Отличия от оригинала:
//   1) onSignalOpenCommit → onOrderOpenCommit (type="schedule" — no-op: отложенный
//      вход отслеживает движок, реальный ордер ставится при активации type="active");
//   2) onSignalCloseCommit → onOrderCloseCommit;
//   3) guard payload.backtest → return в commit-хуках;
//   4) waitForInit дополнен read-only fetchBalance (fail-fast по ключам на старте).
// Тела хелперов и хуков — байт-в-байт авторские.
import { addExchangeSchema, roundTicks, setConfig, Broker } from "backtest-kit";
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

// --- Исполнение: авторский Binance Spot адаптер ---

const FILL_POLL_INTERVAL_MS = 10_000;
const FILL_POLL_ATTEMPTS = 10;
const CANCEL_SETTLE_MS = 2_000;
const STOP_LIMIT_SLIPPAGE = 0.995;

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

async function createLimitOrderAndWait(
  exchange: Binance,
  symbol: string,
  side: "buy" | "sell",
  qty: number,
  price: number,
  restore?: { tpPrice: number; slPrice: number }
): Promise<void> {
  const order = await exchange.createOrder(symbol, "limit", side, qty, price);

  for (let i = 0; i < FILL_POLL_ATTEMPTS; i++) {
    await sleep(FILL_POLL_INTERVAL_MS);
    const status = await exchange.fetchOrder(order.id, symbol);
    if (status.status === "closed") return;
  }

  await exchange.cancelOrder(order.id, symbol);
  await sleep(CANCEL_SETTLE_MS);

  const final     = await exchange.fetchOrder(order.id, symbol);
  const filledQty = final.filled ?? 0;

  if (filledQty > 0) {
    const rollbackSide = side === "buy" ? "sell" : "buy";
    await exchange.createOrder(symbol, "market", rollbackSide, filledQty);
  }

  if (restore) {
    const remainingQty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));
    if (remainingQty > 0) {
      await exchange.createOrder(symbol, "limit", "sell", remainingQty, restore.tpPrice);
      await createStopLossOrder(exchange, symbol, remainingQty, restore.slPrice);
    }
  }

  throw new Error(`Limit order [${side} ${qty} ${symbol} @ ${price}] not filled — backtest-kit will retry`);
}

Broker.useBrokerAdapter(
  class implements Partial<IBroker> {
    async waitForInit(): Promise<void> {
      const exchange = await getSpotExchange();
      await exchange.fetchBalance();
      console.log("SpotBrokerAdapter: ключи валидны, spot-баланс доступен");
    }

    async onOrderOpenCommit(payload: BrokerOrderOpenPayload): Promise<void> {
      if (payload.backtest) return;
      if (payload.type === "schedule") return;
      const { symbol, cost, priceOpen, priceTakeProfit, priceStopLoss, position } = payload;

      if (position === "short") {
        throw new Error(`SpotBrokerAdapter: short position is not supported on spot (symbol=${symbol})`);
      }

      const exchange = await getSpotExchange();
      const qty      = truncateQty(exchange, symbol, cost / priceOpen);

      if (qty <= 0) {
        throw new Error(`Computed qty is zero for ${symbol} — cost=${cost}, price=${priceOpen}`);
      }

      const openPrice = parseFloat(exchange.priceToPrecision(symbol, priceOpen));
      const tpPrice   = parseFloat(exchange.priceToPrecision(symbol, priceTakeProfit));
      const slPrice   = parseFloat(exchange.priceToPrecision(symbol, priceStopLoss));

      await createLimitOrderAndWait(exchange, symbol, "buy", qty, openPrice);

      try {
        await exchange.createOrder(symbol, "limit", "sell", qty, tpPrice);
        await createStopLossOrder(exchange, symbol, qty, slPrice);
      } catch (err) {
        await exchange.createOrder(symbol, "market", "sell", qty);
        throw err;
      }
    }

    async onOrderCloseCommit(payload: BrokerOrderClosePayload): Promise<void> {
      if (payload.backtest) return;
      const { symbol, currentPrice, priceTakeProfit, priceStopLoss } = payload;
      const exchange = await getSpotExchange();

      const openOrders = await exchange.fetchOpenOrders(symbol);
      await cancelAllOrders(exchange, openOrders, symbol);
      await sleep(CANCEL_SETTLE_MS);

      const qty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));
      if (qty === 0) return;

      const closePrice = parseFloat(exchange.priceToPrecision(symbol, currentPrice));
      const tpPrice    = parseFloat(exchange.priceToPrecision(symbol, priceTakeProfit));
      const slPrice    = parseFloat(exchange.priceToPrecision(symbol, priceStopLoss));

      await createLimitOrderAndWait(exchange, symbol, "sell", qty, closePrice, { tpPrice, slPrice });
    }

    async onPartialProfitCommit(payload: BrokerPartialProfitPayload): Promise<void> {
      if (payload.backtest) return;
      const { symbol, percentToClose, currentPrice, priceTakeProfit, priceStopLoss } = payload;
      const exchange = await getSpotExchange();

      const openOrders = await exchange.fetchOpenOrders(symbol);
      await cancelAllOrders(exchange, openOrders, symbol);
      await sleep(CANCEL_SETTLE_MS);

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
          await exchange.createOrder(symbol, "limit", "sell", remainingQty, tpPrice);
          await createStopLossOrder(exchange, symbol, remainingQty, slPrice);
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

      const openOrders = await exchange.fetchOpenOrders(symbol);
      await cancelAllOrders(exchange, openOrders, symbol);
      await sleep(CANCEL_SETTLE_MS);

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
          await exchange.createOrder(symbol, "limit", "sell", remainingQty, tpPrice);
          await createStopLossOrder(exchange, symbol, remainingQty, slPrice);
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

      const orders  = await exchange.fetchOpenOrders(symbol);
      const slOrder = orders.find((o) =>
        o.side === "sell" &&
        ["stop_loss_limit", "stop", "STOP_LOSS_LIMIT"].includes(o.type ?? "")
      ) ?? null;
      if (slOrder) {
        await exchange.cancelOrder(slOrder.id, symbol);
        await sleep(CANCEL_SETTLE_MS);
      }

      const qty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));
      if (qty === 0) {
        throw new Error(`TrailingStop skipped: no open position for ${symbol}`);
      }

      const slPrice = parseFloat(exchange.priceToPrecision(symbol, newStopLossPrice));
      await createStopLossOrder(exchange, symbol, qty, slPrice);
    }

    async onTrailingTakeCommit(payload: BrokerTrailingTakePayload): Promise<void> {
      if (payload.backtest) return;
      const { symbol, newTakeProfitPrice } = payload;
      const exchange = await getSpotExchange();

      const orders  = await exchange.fetchOpenOrders(symbol);
      const tpOrder = orders.find((o) =>
        o.side === "sell" &&
        ["limit", "LIMIT"].includes(o.type ?? "")
      ) ?? null;
      if (tpOrder) {
        await exchange.cancelOrder(tpOrder.id, symbol);
        await sleep(CANCEL_SETTLE_MS);
      }

      const qty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));
      if (qty === 0) {
        throw new Error(`TrailingTake skipped: no open position for ${symbol}`);
      }

      const tpPrice = parseFloat(exchange.priceToPrecision(symbol, newTakeProfitPrice));
      await exchange.createOrder(symbol, "limit", "sell", qty, tpPrice);
    }

    async onBreakevenCommit(payload: BrokerBreakevenPayload): Promise<void> {
      if (payload.backtest) return;
      const { symbol, newStopLossPrice } = payload;
      const exchange = await getSpotExchange();

      const orders  = await exchange.fetchOpenOrders(symbol);
      const slOrder = orders.find((o) =>
        o.side === "sell" &&
        ["stop_loss_limit", "stop", "STOP_LOSS_LIMIT"].includes(o.type ?? "")
      ) ?? null;
      if (slOrder) {
        await exchange.cancelOrder(slOrder.id, symbol);
        await sleep(CANCEL_SETTLE_MS);
      }

      const qty = truncateQty(exchange, symbol, await fetchFreeQty(exchange, symbol));
      if (qty === 0) {
        throw new Error(`Breakeven skipped: no open position for ${symbol}`);
      }

      const slPrice = parseFloat(exchange.priceToPrecision(symbol, newStopLossPrice));
      await createStopLossOrder(exchange, symbol, qty, slPrice);
    }

    async onAverageBuyCommit(payload: BrokerAverageBuyPayload): Promise<void> {
      if (payload.backtest) return;
      const { symbol, currentPrice, cost, priceTakeProfit, priceStopLoss } = payload;
      const exchange = await getSpotExchange();

      const openOrders = await exchange.fetchOpenOrders(symbol);
      await cancelAllOrders(exchange, openOrders, symbol);
      await sleep(CANCEL_SETTLE_MS);

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
        await exchange.createOrder(symbol, "limit", "sell", totalQty, tpPrice);
        await createStopLossOrder(exchange, symbol, totalQty, slPrice);
      } catch (err) {
        await exchange.createOrder(symbol, "market", "sell", totalQty);
        throw err;
      }
    }
  }
);

Broker.enable();
