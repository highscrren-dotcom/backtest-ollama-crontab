import {
  addStrategySchema,
  listenError,
  listenActivePing,
  Log,
  getPositionHighestProfitDistancePnlCost,
  getPositionHighestMaxDrawdownPnlCost,
  getPositionHighestProfitDistancePnlPercentage,
  getPositionHighestPnlPercentage,
  getPositionHighestProfitMinutes,
  getPositionPnlCost,
  getPositionPnlPercent,
  getClosePrice,
  commitClosePending,
  Position,
  Cron,
} from "backtest-kit";
import { errorData, getErrorMessage } from "functools-kit";

// Выходы по совету автора (телега 17.07.2026 19:44-46, «НИКОГДА НЕ СТАВЬ TP/SL
// ФИКСИРОВАННЫМ ОКНОМ»): канальные TP/SL заменены на moonbag (жёсткий стоп −1%)
// + trailing take / peak staleness (его константы as-is). id сигнала из базы
// сохранён — канон идемпотентности (clientOrderId=signalId в адаптере).
const PEAK_STALENESS_SINCE_PROFIT = 1.0;
const PEAK_STALENESS_SINCE_MINUTES = 240;
const TRAILING_TAKE = 1.0;
const HARD_STOP = 1.0;

addStrategySchema({
  strategyName: "jan_2026_strategy",
  getSignal: async (symbol, when, currentPrice) => {
    console.log(symbol, when);

    const signal = await core.signalMainService.getLast4HourSignal(symbol, when);

    if (!signal) {
      return null;
    }

    // Решение об открытии позиции принимает LLM. Эмпирические правила
    // (sleeping coin SHORT, knife-catching LONG) живут в outline-промпте.
    // Здесь стратегия только следует вердикту.
    if (signal.riskAction === "skip") {
      return null;
    }

    const closePrice = await getClosePrice(symbol, "1m");
    if (closePrice < signal.entryFrom || closePrice > signal.entryTo) {
      return null;
    }

    const info = {
      publishedAt: signal.publishedAt,
      data: {
        direction: signal.direction,
        entryFrom: signal.entryFrom,
        entryTo: signal.entryTo,
        targets: signal.targets,
        stoploss: signal.stoploss,
      },
      risk: {
        action: signal.riskAction,
        sureLevel: signal.riskSureLevel,
        confidence: signal.riskConfidence,
        description: signal.riskDescription,
        reasoning: signal.riskReasoning,
      },
      parsed: signal.note,
    };

    return {
      id: signal.id,
      ...Position.moonbag({
        position: signal.direction,
        currentPrice,
        percentStopLoss: HARD_STOP,
      }),
      minuteEstimatedTime: 24 * 60,
      note: JSON.stringify(info, null, 2),
    };
  },
});

// Trailing take: в профите отдали ≥1 п.п. от пика → закрыть (код автора).
listenActivePing(async ({ symbol, data }) => {
  const peakProfitDistance =
    await getPositionHighestProfitDistancePnlPercentage(symbol);
  const currentProfit = await getPositionPnlPercent(symbol);
  if (currentProfit < 0) {
    return;
  }
  if (peakProfitDistance < TRAILING_TAKE) {
    return;
  }
  Log.info("position closed due to the trailing take", { symbol, data });
  await commitClosePending(symbol, {
    id: "unknown",
    note: "# Позиция закрыта по trailing take",
  });
});

// Peak staleness: пик ≥1% был ≥240 мин назад — движение выдохлось, закрыть.
listenActivePing(async ({ symbol, data }) => {
  const peakProfitCost = await getPositionHighestPnlPercentage(symbol);
  const peakProfitMinutes = await getPositionHighestProfitMinutes(symbol);
  if (peakProfitCost < PEAK_STALENESS_SINCE_PROFIT) {
    return;
  }
  if (peakProfitMinutes < PEAK_STALENESS_SINCE_MINUTES) {
    return;
  }
  Log.info("position closed due to the peak staleness", { symbol, data });
  await commitClosePending(symbol, {
    id: "unknown",
    note: "# Позиция закрыта по peak staleness",
  });
});

listenActivePing(async ({ symbol, data, currentPrice }) => {
  const peakProfitDistance = await getPositionHighestProfitDistancePnlCost(symbol);
  const peakMaxDrawdown = await getPositionHighestMaxDrawdownPnlCost(symbol);
  const currentPnl = await getPositionPnlCost(symbol);
  Log.info("position active", {
    symbol,
    signalId: data.id,
    priceOpen: data.priceOpen,
    takeProfit: data.priceTakeProfit,
    stopLoss: data.priceStopLoss,
    currentPrice,
    peakProfitDistance,
    peakMaxDrawdown,
    currentPnl,
  });
});

listenError((error) => {
  console.log(error);
  Log.debug("error", {
    error: errorData(error),
    message: getErrorMessage(error),
  });
});

Cron.register({
  name: "backtest-prepare-data",
  handler: async ({ symbol, when, backtest }) => {
    if (!backtest) {
      return;
    }
    console.log(`Fetching backtest data symbol=${symbol} when=${when}`)
    await core.crawlerMainService.crawlBacktestFrame(when);
  },
});

Cron.register({
  name: "live-fetch-data",
  handler: async ({ symbol, when, backtest }) => {
    if (backtest) {
      return;
    }
    console.log(`Fetching live data symbol=${symbol} when=${when}`)
    await core.crawlerMainService.crawlLiveFrame(when);
  },
  interval: "15m",
})

