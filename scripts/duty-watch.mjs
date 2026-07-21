/**
 * ФОРК-ДОБАВКА: системная 2ч-вахта контура (№96а) — живёт в user-crontab,
 * НЕ зависит от IDE/сессий (урок 18.07: сессионные кроны «проспали» ночь).
 *
 * Крон-строка: каждые 2 часа в :23 (минута/час = «23 звёздочка-дробь-2»),
 * cd в корень форка, node АБСОЛЮТНЫМ путём (урок PATH в кроне),
 * вывод >> logs/duty-watch.log 2>&1. Точная строка — в user-crontab.
 *
 * Политика: красное → алерт в телегу КАЖДЫЙ тик, пока красное; смена
 * max messageId / появление signal-items → отдельный алерт (главная вахта);
 * зелёный heartbeat «вахта жива» в 08:23/14:23/20:23 (вариант C владельца
 * 20.07 — ~каждые 6ч, не каждые 2ч; deadman: нет heartbeat = вахта мертва).
 * Числа сравниваем только в node (урок awk/ru_RU).
 * Read-only: ордеров не размещает, Mongo только чтение.
 */
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = "/home/s1dd1/dev/quant/backtest-ollama-crontab";
const PH = "/home/s1dd1/dev/quant/paperhands";
const STATE_FILE = `${ROOT}/logs/duty-watch-state.json`;
const TEST = process.argv.includes("--test");

// Скрипт не имеет права висеть (cron накопит зомби): жёсткий выход через 120с.
const killer = setTimeout(() => {
  console.log(`[${new Date().toISOString()}] HARD TIMEOUT 120s — выходим`);
  process.exit(2);
}, 120_000);
killer.unref();

const env = Object.fromEntries(
  readFileSync(`${ROOT}/.env`, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : {};

const red = []; // алерты
const info = []; // заметки в лог

const sh = (cmd) => {
  try {
    return execSync(cmd, { timeout: 15_000, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const ageMin = (path) => {
  try {
    return (Date.now() - statSync(path).mtimeMs) / 60_000;
  } catch {
    return Infinity;
  }
};

// 1-2. Процессы live/paper
const livePid = sh(`pgrep -f "index[.]mjs --live" | head -1`);
const paperPid = sh(`pgrep -f "index[.]mjs --paper" | head -1`);
if (!livePid) red.push("live-бот НЕ ЗАПУЩЕН (systemd-run по строке @reboot)");
if (!paperPid) red.push("paper feb НЕ ЗАПУЩЕН (systemd-run bash scripts/run_paper_feb.sh)");

// 3-4. Свежесть тиков
const liveLogAge = ageMin(`${ROOT}/logs/live-ingest.log`);
if (liveLogAge > 10) red.push(`live-ingest.log протух ${liveLogAge.toFixed(0)} мин`);
const febAge = ageMin(`${PH}/example/content/feb_2026.strategy/dump/report/live.jsonl`);
if (febAge > 10) red.push(`feb live.jsonl протух ${febAge.toFixed(0)} мин`);

// 5. Рост watchdog (слот виснет — класс №87)
const wd = Number(sh(`grep -c watchdog ${ROOT}/logs/live-ingest.log`) ?? -1);
if (wd >= 0 && state.watchdog != null && wd > state.watchdog)
  red.push(`watchdog вырос ${state.watchdog}→${wd} — слот виснет (№87)`);
if (wd >= 0) state.watchdog = wd;

// 6. ОЗУ и RSS live-бота
const memAvailKb = Number(
  (readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/) || [])[1] ?? 0,
);
if (memAvailKb && memAvailKb < 2 * 1024 * 1024)
  red.push(`MemAvailable ${(memAvailKb / 1024 / 1024).toFixed(1)}G < 2G (урок OOM)`);
if (livePid) {
  const rssKb = Number(sh(`ps -o rss= -p ${livePid}`) ?? 0);
  if (rssKb > 1024 * 1024) red.push(`RSS live-бота ${(rssKb / 1024).toFixed(0)}M > 1G`);
}

// 7. Кроны по mtime логов
const forwardAge = ageMin(`${PH}/example/scripts/pump_bench/out/forward-cron.log`);
if (forwardAge > 70) red.push(`forward-cron.log протух ${forwardAge.toFixed(0)} мин`);
const volAge = ageMin(`${PH}/example/out/volume-monitor.log`);
if (volAge > 20) red.push(`volume-monitor.log протух ${volAge.toFixed(0)} мин`);
const newsAge = ageMin(`${PH}/agent/notes/news-dataset/news-cron.log`);
if (newsAge > 25 * 60) red.push(`news-cron.log протух ${(newsAge / 60).toFixed(1)} ч — догон: collect week`);

// 8. Mongo: посты канала и сигналы (ГЛАВНАЯ ВАХТА)
try {
  const mongoose = require("mongoose");
  await mongoose.connect("mongodb://localhost:27017/backtest-pro?wtimeoutMS=10000", {
    serverSelectionTimeoutMS: 8000,
  });
  const db = mongoose.connection.db;
  const top = await db.collection("parser-items").find({}).sort({ messageId: -1 }).limit(1).toArray();
  const maxMsg = top[0]?.messageId ?? 0;
  const signals = await db.collection("signal-items").countDocuments();
  if (state.maxMsg != null && maxMsg > state.maxMsg) {
    const scr = await db
      .collection("screen-items")
      .find({})
      .sort({ publishedAt: -1 })
      .limit(1)
      .toArray();
    const s = scr[0] || {};
    red.push(
      `📨 НОВЫЙ ПОСТ канала №${maxMsg} (${s.symbol ?? "?"} ${s.direction ?? "?"} risk=${s.riskAction ?? "ещё нет"}) — проверить разбор`,
    );
  }
  if (state.signals != null && signals > state.signals)
    red.push(`⚡ SIGNAL-ITEMS ${state.signals}→${signals} — БОЕВОЙ СИГНАЛ В РАБОТЕ (адаптер 16.1.0 + trailing, разбор!)`);
  state.maxMsg = maxMsg;
  state.signals = signals;
  info.push(`mongo: msg=${maxMsg} signals=${signals}`);
  await mongoose.disconnect();
} catch (e) {
  red.push(`Mongo недоступен: ${String(e).slice(0, 80)}`);
}

// 9. Сироты: не-USDT актив >$5 при signals=0 (№88)
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

// 10-11. news-service: докер + health
const dockerNews = sh(`/usr/bin/docker ps --format '{{.Names}} {{.Status}}' | grep news-service`) || "";
if (!dockerNews.includes("healthy")) red.push(`news-service docker НЕ healthy: "${dockerNews || "нет контейнера"}" (docker compose up -d)`);
try {
  const r = await fetch("http://127.0.0.1:8080/api/v1/health", { signal: AbortSignal.timeout(8000) });
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
// Вариант C (владелец 20.07): зелёный heartbeat ~каждые 6ч (утро/день/вечер),
// а не каждые 2ч — видно, что вахта жива, без спама. red и главная вахта
// (сигнал канала/сироты) шлются на ЛЮБОМ тике мгновенно.
const HEARTBEAT_HOURS = [8, 14, 20]; // локальные часы; крон-тики :23 попадают на них
const isHeartbeat = HEARTBEAT_HOURS.includes(now.getHours());

let sent = null;
if (TEST) {
  sent = await tg(`🧪 duty-watch тест: вахта установлена. Сейчас: ${red.length ? "🔴 " + red.join("; ") : "🟢 всё зелёное"} | ${info.join(", ")}`);
} else if (red.length) {
  sent = await tg(`🔴 вахта ${stamp}:\n- ${red.join("\n- ")}`);
} else if (isHeartbeat) {
  sent = await tg(`🟢 вахта жива (${stamp}): всё зелёное | ${info.join(", ")}`);
}

writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
console.log(
  `[${stamp}] red=${red.length} ${red.join(" | ") || "OK"} | ${info.join(", ")} | tg=${sent === null ? "не слали" : sent ? "ok" : "СБОЙ"}`,
);
process.exit(0);
