/**
 * ФОРК-ДОБАВКА: экспорт Mongo-коллекций в формат ParserItem библиотеки
 * pump-anomaly (и нашего стенда paperhands/example/scripts/pump_bench/):
 *   { id, channel, symbol, direction, ts(ms), entryFromPrice, entryToPrice,
 *     targets, stoploss, note }  — extra-поля pump-anomaly игнорирует.
 *
 * Использование (из корня репо, mongo должен быть поднят):
 *   node scripts/export-parser-items.mjs                       # все parser-items
 *   node scripts/export-parser-items.mjs --screened            # только riskAction=follow из screen-items
 *   node scripts/export-parser-items.mjs --out items.json      # путь вывода
 *   CC_MONGO_CONNECTION_STRING=... node scripts/export-parser-items.mjs
 */
import { writeFileSync } from "node:fs";
import mongoose from "mongoose";

const MONGO =
  process.env.CC_MONGO_CONNECTION_STRING ||
  "mongodb://localhost:27017/backtest-pro?wtimeoutMS=15000";

const args = process.argv.slice(2);
const screened = args.includes("--screened");
const outIdx = args.indexOf("--out");
const outFile =
  outIdx !== -1 ? args[outIdx + 1] : screened ? "screened-items.json" : "parser-items.json";

await mongoose.connect(MONGO);
const db = mongoose.connection.db;

let items;
if (screened) {
  const rows = await db
    .collection("screen-items")
    .find({ riskAction: "follow" })
    .sort({ publishedAt: 1 })
    .toArray();
  items = rows.map((r) => ({
    id: String(r.parserItemId),
    channel: r.channel,
    symbol: r.symbol,
    direction: r.direction,
    ts: new Date(r.publishedAt).getTime(),
    entryFromPrice: r.entryFrom,
    entryToPrice: r.entryTo,
    targets: r.targets,
    stoploss: r.stoploss,
    note: r.note,
  }));
} else {
  const rows = await db
    .collection("parser-items")
    .find({})
    .sort({ publishedAt: 1 })
    .toArray();
  items = rows.map((r) => ({
    id: String(r._id),
    channel: r.channel,
    symbol: r.symbol,
    direction: r.direction,
    ts: new Date(r.publishedAt).getTime(),
    entryFromPrice: r.entry?.from,
    entryToPrice: r.entry?.to,
    targets: r.targets,
    stoploss: r.stoploss,
    note: r.note,
  }));
}

writeFileSync(outFile, JSON.stringify(items, null, 2));
console.log(
  `exported ${items.length} items (${screened ? "screen-items, riskAction=follow" : "parser-items"}) → ${outFile}`,
);
await mongoose.disconnect();
