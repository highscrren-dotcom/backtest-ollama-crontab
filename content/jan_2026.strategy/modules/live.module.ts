import { addExchangeSchema, roundTicks, setConfig, Broker } from "backtest-kit";
import type {
  IBroker,
  BrokerOrderOpenPayload,
  BrokerOrderClosePayload,
} from "backtest-kit";
import { singleshot } from "functools-kit";
import ccxt from "ccxt";

setConfig({
  CC_MAX_STOPLOSS_DISTANCE_PERCENT: 100,
});

// --- Данные: публичный spot-клиент, дословно как modules/live.module.ts автора ---

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

// --- Исполнение: аутентифицированный spot-клиент (BINANCE_API_KEY/SECRET из .env) ---

const getTradeExchange = singleshot(async () => {
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
    throw new Error(
      "BINANCE_API_KEY/BINANCE_API_SECRET не заданы в .env — live-исполнение невозможно.",
    );
  }
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

class SpotLiveBroker implements Partial<IBroker> {
  async waitForInit(): Promise<void> {
    const exchange = await getTradeExchange();
    // read-only проба: валидность ключей до первого ордера
    await exchange.fetchBalance();
    console.log("SpotLiveBroker: ключи валидны, spot-баланс доступен");
  }

  async onOrderOpenCommit(payload: BrokerOrderOpenPayload): Promise<void> {
    if (payload.backtest) {
      return;
    }
    // "schedule" = постановка отложенного входа: реальный ордер НЕ ставим —
    // активацию по цене отслеживает фреймворк, реальный вход по type="active".
    if (payload.type === "schedule") {
      return;
    }
    if (payload.position !== "long") {
      // Спот шортить не умеет. Шорты отфильтрованы в getSignal; это страховка.
      // THROW = откат: фреймворк НЕ запишет позицию открытой.
      throw new Error(
        `SpotLiveBroker: short на споте не поддерживается (signal ${payload.signalId})`,
      );
    }
    const exchange = await getTradeExchange();
    const quantity = Number(
      exchange.amountToPrecision(payload.symbol, payload.cost / payload.priceOpen),
    );
    console.log(
      `SpotLiveBroker OPEN long ${payload.symbol} qty=${quantity} ~$${payload.cost} @ ${payload.priceOpen} signal=${payload.signalId}`,
    );
    await exchange.createOrder(payload.symbol, "market", "buy", quantity, undefined, {
      clientOrderId: `bk_${payload.signalId.slice(0, 28)}`,
    });
  }

  async onOrderCloseCommit(payload: BrokerOrderClosePayload): Promise<void> {
    if ((payload as { backtest?: boolean }).backtest) {
      return;
    }
    if (payload.position !== "long") {
      throw new Error(
        `SpotLiveBroker: short-close на споте не поддерживается (signal ${payload.signalId})`,
      );
    }
    const exchange = await getTradeExchange();
    const market = exchange.market(payload.symbol);
    const base = market.base;
    // Продаём фактический остаток базовой монеты (защита от дрейфа частичных
    // филлов), но не больше размера позиции по данным движка.
    const balance = await exchange.fetchBalance();
    const free = balance[base]?.free ?? 0;
    const engineQty = payload.cost / payload.priceOpen;
    const quantity = Number(
      exchange.amountToPrecision(payload.symbol, Math.min(free, engineQty * 1.001)),
    );
    if (!(quantity > 0)) {
      throw new Error(
        `SpotLiveBroker CLOSE: нет ${base} на балансе (free=${free}) для закрытия signal=${payload.signalId}`,
      );
    }
    console.log(
      `SpotLiveBroker CLOSE long ${payload.symbol} qty=${quantity} @ ~${payload.currentPrice} signal=${payload.signalId} pnl=${payload.pnl?.pnlPercentage ?? "?"}%`,
    );
    await exchange.createOrder(payload.symbol, "market", "sell", quantity, undefined, {
      clientOrderId: `bk_x_${payload.signalId.slice(0, 26)}`,
    });
  }
}

Broker.useBrokerAdapter(SpotLiveBroker);
Broker.enable();
