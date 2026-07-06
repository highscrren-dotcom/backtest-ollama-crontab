import { inject } from "../../core/di";
import { IParserRow } from "../../../schema/Parser.schema";
import { IScreenDto } from "../../../schema/Screen.schema";
import LoggerService from "../base/LoggerService";
import TYPES from "../../core/types";
import { json } from "agent-swarm-kit";
import { getCandles } from "backtest-kit";
import OutlineName from "src/enum/OutlineName";
import { RiskOutlineContract } from "src/contract/RiskOutline";
import { CC_RISK_GATE } from "../../../config/params";

type Symbol = string;
type Direction = "short" | "long";
type Targets = number[];
type StopLoss = number;

type Args = [Symbol, Direction, Targets, StopLoss];

type RiskVerdict = {
  action: "skip" | "follow";
  sure_level: "low" | "low_medium" | "medium" | "medium_high" | "high";
  confidence: "reliable" | "not_reliable";
  description: string;
  reasoning: string;
};

const RUN_OUTLINE_FN = async (row: IParserRow) => {
  const { data, error, isValid } = await json<RiskOutlineContract, Args>(
    OutlineName.RiskOutline,
    row.symbol,
    row.direction,
    row.targets,
    row.stoploss,
  );

  if (!isValid) {
    throw new Error(error);
  }

  return data;
};

// ФОРК-ПРАВКА (CC_RISK_GATE=rules): те же ПРАВИЛА 1-3, что LLM исполняет промптом
// (константы и текст — logic/outline/risk.outline.ts), но детерминированно.
// Формулы идентичны закомментированной if-версии автора в
// content/jan_2026.strategy/jan_2026.test.ts. Вызывается внутри
// ExecutionContextService.runInContext (SignalJobService) — getCandles look-ahead-safe.
const PRE_CANDLES_LIMIT = 1440; // 24h 1m свечей до публикации
const SHORT_MIN_AVG_RANGE_PCT = 0.07;
const LONG_MIN_MOMENTUM_24H_PCT = -1;

const RUN_RULES_FN = async (row: IParserRow): Promise<RiskVerdict> => {
  const candles = await getCandles(row.symbol, "1m", PRE_CANDLES_LIMIT);
  const confidence: RiskVerdict["confidence"] =
    candles.length >= PRE_CANDLES_LIMIT / 4 ? "reliable" : "not_reliable";
  const avgRangePct = candles.length
    ? candles.reduce((acc, c) => acc + ((c.high - c.low) / c.close) * 100, 0) /
      candles.length
    : 0;
  const momentum24hPct = candles.length
    ? ((candles[candles.length - 1].close - candles[0].open) /
        candles[0].open) *
      100
    : 0;
  const metrics = `avgRangePct=${avgRangePct.toFixed(4)}%, momentum24hPct=${momentum24hPct.toFixed(2)}%, candles=${candles.length}`;
  let action: RiskVerdict["action"] = "follow";
  let description = `ПРАВИЛО 3 (default): follow. ${metrics}`;
  if (row.direction === "short" && avgRangePct < SHORT_MIN_AVG_RANGE_PCT) {
    action = "skip";
    description = `ПРАВИЛО 1 (sleeping coin SHORT): avgRangePct=${avgRangePct.toFixed(4)}% < ${SHORT_MIN_AVG_RANGE_PCT}% — stop-hunt мишень. ${metrics}`;
  } else if (
    row.direction === "long" &&
    momentum24hPct < LONG_MIN_MOMENTUM_24H_PCT
  ) {
    action = "skip";
    description = `ПРАВИЛО 2 (knife-catching LONG): momentum24hPct=${momentum24hPct.toFixed(2)}% < ${LONG_MIN_MOMENTUM_24H_PCT}% — ловля ножей. ${metrics}`;
  }
  return {
    action,
    sure_level: "medium",
    confidence,
    description,
    reasoning:
      "Детерминированный гейт (CC_RISK_GATE=rules): правила идентичны LLM-промпту risk.outline.ts, sure_level не оценивается (нейтральное medium).",
  };
};

const OFF_VERDICT: RiskVerdict = {
  action: "follow",
  sure_level: "medium",
  confidence: "not_reliable",
  description: "Риск-гейт выключен (CC_RISK_GATE=off) — сигнал пропущен без проверки.",
  reasoning: "Гейт отключён конфигурацией; поля риска номинальные.",
};

const RUN_GATE_FN = async (row: IParserRow): Promise<RiskVerdict> => {
  if (CC_RISK_GATE === "rules") {
    return await RUN_RULES_FN(row);
  }
  if (CC_RISK_GATE === "off") {
    return OFF_VERDICT;
  }
  return await RUN_OUTLINE_FN(row);
};

export class SignalLogicService {
  readonly loggerService = inject<LoggerService>(TYPES.loggerService);

  public execute = async (row: IParserRow): Promise<IScreenDto> => {
    this.loggerService.log("signalLogicService execute", {
      rowId: row.id,
      riskGate: CC_RISK_GATE,
    });
    const outline = await RUN_GATE_FN(row);
    console.log("Reviewed:", {
      row,
      outline,
    });
    return {
      parserItemId: row.id,
      channel: row.channel,
      source: row.source,
      publishedAt: row.publishedAt,
      symbol: row.symbol,
      direction: row.direction,
      entryFrom: row.entry.from,
      entryTo: row.entry.to,
      targets: row.targets,
      stoploss: row.stoploss,
      riskSureLevel: outline.sure_level,
      riskConfidence: outline.confidence,
      riskAction: outline.action,
      riskDescription: outline.description,
      riskReasoning: outline.reasoning,
      note: row.note,
      content: row.content,
    };
  };
}

export default SignalLogicService;
