/**
 * Серверная вахта контура (Coolify, контейнер quant-live-cron) — наследник
 * scripts/duty-watch.mjs, переписан с ноутбучных допущений (pgrep, абсолютные
 * пути двух реп, /usr/bin/docker, чтение .env с диска) на сетевые проверки.
 *
 * Проверки: paper-UI и live-UI по HTTP (любой ответ = жив, сетевая ошибка =
 * мёртв), mongo (главная вахта: max messageId + signal-items), news-service
 * health, сироты на Binance, свежесть logs/live-ingest.log (общий volume с
 * quant-live). Live-проверки только при LIVE_ENABLED=1 (движок паркуется гейтом
 * deploy/run-live.sh — без гейта вахта спамила бы красным).
 *
 * Конфиг — только process.env (Coolify): MONGO_URL, NEWS_HEALTH_URL, PAPER_UI,
 * LIVE_UI, LIVE_ENABLED, BINANCE_API_KEY/SECRET, CC_TELEGRAM_TOKEN/CHANNEL.
 * Политика та же: красное → телега каждый тик; зелёный heartbeat в 08/14/20
 * локальных часов (TZ контейнера). Read-only: ордеров не размещает.
 */
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const env = process.env;
const LIVE_ON = env.LIVE_ENABLED === "1";
const MONGO = env.MONGO_URL || "mongodb://quant-mongo:27017/backtest-pro";
const NEWS_HEALTH = env.NEWS_HEALTH_URL || "http://quant-news:8080/api/v1/health";
const PAPER_UI = env.PAPER_UI || "http://quant-paper:60052/";
const LIVE_UI = env.LIVE_UI || "http://quant-live:60050/";
const STATE_FILE = "/app/logs/duty-watch-state.json";
const TEST = process.argv.includes("--test");

// Скрипт не имеет права висеть (cron накопит зомби): жёсткий выход через 120с.
const killer = setTimeout(() => {
  console.log(`[${new Date().toISOString()}] HARD TIMEOUT 120s — выходим`);
  process.exit(2);
}, 120_000);
killer.unref();

const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : {};

const red = [];
const info = [];

// «Жив» = порт отвечает по HTTP чем угодно (404 тоже ок); ошибка сети = мёртв.
const alive = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(8000) });
    return true;
  } catch {
    return false;
  }
};
const ageMin = (path) => {
  try {
    return (Date.now() - statSync(path).mtimeMs) / 60_000;
  } catch {
    return Infinity;
  }
};

// 1-2. Живость движков по UI-портам
if (!(await alive(PAPER_UI))) red.push(`paper-движок недоступен (${PAPER_UI})`);
if (LIVE_ON) {
  if (!(await alive(LIVE_UI))) red.push(`live-движок недоступен (${LIVE_UI}) при LIVE_ENABLED=1`);
  const liveLogAge = ageMin("/app/logs/live-ingest.log");
  if (liveLogAge > 10) red.push(`live-ingest.log протух ${liveLogAge.toFixed(0)} мин`);
} else {
  info.push("live: выключен гейтом (LIVE_ENABLED!=1)");
}

// 3. Mongo: посты канала и сигналы (ГЛАВНАЯ ВАХТА)
try {
  const mongoose = require("mongoose");
  await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;
  const top = await db.collection("parser-items").find({}).sort({ messageId: -1 }).limit(1).toArray();
  const maxMsg = top[0]?.messageId ?? 0;
  const signals = await db.collection("signal-items").countDocuments();
  if (state.maxMsg != null && maxMsg > state.maxMsg) {
    const scr = await db.collection("screen-items").find({}).sort({ publishedAt: -1 }).limit(1).toArray();
    const s = scr[0] || {};
    red.push(
      `📨 НОВЫЙ ПОСТ канала №${maxMsg} (${s.symbol ?? "?"} ${s.direction ?? "?"} risk=${s.riskAction ?? "ещё нет"}) — проверить разбор`,
    );
  }
  if (state.signals != null && signals > state.signals)
    red.push(`⚡ SIGNAL-ITEMS ${state.signals}→${signals} — БОЕВОЙ СИГНАЛ В РАБОТЕ (разбор!)`);
  state.maxMsg = maxMsg;
  state.signals = signals;
  info.push(`mongo: msg=${maxMsg} signals=${signals}`);
  await mongoose.disconnect();
} catch (e) {
  red.push(`Mongo недоступен: ${String(e).slice(0, 80)}`);
}

// 4. Сироты: не-USDT актив >$5 при signals=0 (№88)
try {
  const ccxt = require("ccxt");
  const ex = new ccxt.binance({
    apiKey: env.BINANCE_API_KEY,
    secret: env.BINANCE_API_SECRET,
    options: { defaultType: "spot", adjustForTimeDifference: true },
    enableRateLimit: true,
  });
  const bal = await ex.fetchBalance();
  for (const [asset, total] of Object.entries(bal.total ?? {})) {
    if (asset === "USDT" || !total || total <= 0 || asset.startsWith("LD")) continue;
    let usd = null;
    try {
      usd = total * (await ex.fetchTicker(`${asset}/USDT`)).last;
    } catch {}
    if (usd !== null && usd > 5 && (state.signals ?? 0) === 0)
      red.push(`СИРОТА? ${asset} ≈ $${usd.toFixed(2)} при signal-items=0 (№88)`);
  }
  info.push(`USDT free=${bal.USDT?.free ?? "?"}`);
} catch (e) {
  red.push(`fetchBalance сбой: ${String(e).slice(0, 80)}`);
}

// 5. news-service health
try {
  const r = await fetch(NEWS_HEALTH, { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (j.status !== "ok") red.push(`news-service health: ${JSON.stringify(j).slice(0, 80)}`);
} catch (e) {
  red.push(`news-service health недоступен: ${String(e).slice(0, 60)}`);
}

// Телеграм
async function tg(text) {
  const r = await fetch(`https://api.telegram.org/bot${env.CC_TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.CC_TELEGRAM_CHANNEL, text }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await r.json().catch(() => ({}));
  return j.ok === true;
}

const now = new Date();
const stamp = now.toISOString();
// Решение владельца 21.07 (после переезда на сервер): ОТЧЁТ КАЖДЫЙ 2ч-тик —
// зелёный или красный, всегда со сводкой (mongo/сигналы/баланс). Заменяет
// вариант C (heartbeat 3×/день) — с ноута контур больше не виден, телега
// теперь единственное окно в бой.
let sent = null;
if (TEST) {
  sent = await tg(`🧪 duty-watch-server тест (Coolify): ${red.length ? "🔴 " + red.join("; ") : "🟢 всё зелёное"} | ${info.join(", ")}`);
} else if (red.length) {
  sent = await tg(`🔴 вахта-сервер ${stamp}:\n- ${red.join("\n- ")}\n${info.join(", ")}`);
} else {
  sent = await tg(`🟢 вахта-сервер ${stamp}: всё зелёное | ${info.join(", ")}`);
}

writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
console.log(
  `[${stamp}] red=${red.length} ${red.join(" | ") || "OK"} | ${info.join(", ")} | tg=${sent === null ? "не слали" : sent ? "ok" : "СБОЙ"}`,
);
process.exit(0);
