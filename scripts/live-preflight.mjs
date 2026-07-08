// Read-only préflight перед go-live: валидность Binance-ключей (без ордеров),
// права ключа, баланс USDT, доступность бота Telegram. Запуск из корня форка:
//   node scripts/live-preflight.mjs
import { config } from "dotenv";
import ccxt from "ccxt";

config({ path: new URL("../.env", import.meta.url).pathname });

let fail = false;

// --- Binance spot: ключи и права (GET /api/v3/account — read-only) ---
try {
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
    throw new Error("BINANCE_API_KEY/BINANCE_API_SECRET не заданы в .env");
  }
  const ex = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_API_SECRET,
    options: { defaultType: "spot", adjustForTimeDifference: true },
    enableRateLimit: true,
  });
  const bal = await ex.fetchBalance();
  const usdt = bal.USDT?.free ?? 0;
  console.log(`Binance: ключи ВАЛИДНЫ`);
  console.log(`  USDT free=${usdt}`);
  // Права именно КЛЮЧА (не аккаунта): GET /sapi/v1/account/apiRestrictions
  const restr = await ex.sapiGetAccountApiRestrictions();
  console.log(
    `  ключ: spotTrading=${restr.enableSpotAndMarginTrading} withdrawals=${restr.enableWithdrawals} reading=${restr.enableReading} ipRestrict=${restr.ipRestrict}`,
  );
  if (String(restr.enableSpotAndMarginTrading) !== "true") {
    console.log("  ⚠️ Spot Trading у ключа ВЫКЛЮЧЕН — ордер не пройдёт");
    fail = true;
  }
  if (String(restr.enableWithdrawals) === "true") {
    console.log("  ⚠️ У ключа включён ВЫВОД СРЕДСТВ — выключить!");
    fail = true;
  }
  if (String(restr.ipRestrict) !== "true") {
    console.log("  ℹ️ ключ без IP-whitelist — Binance авто-отзовёт его через ~90 дней");
  }
  if (!(usdt > 0)) {
    console.log("  ⚠️ USDT=0 — spot-кошелёк не финансирован, ордер не пройдёт");
  }
} catch (e) {
  console.log(`Binance: FAIL — ${e.constructor?.name}: ${e.message?.slice(0, 200)}`);
  fail = true;
}

// --- Telegram-бот алертов: getMe (read-only) ---
try {
  if (!process.env.CC_TELEGRAM_TOKEN) throw new Error("CC_TELEGRAM_TOKEN не задан");
  const r = await fetch(`https://api.telegram.org/bot${process.env.CC_TELEGRAM_TOKEN}/getMe`);
  const j = await r.json();
  if (!j.ok) throw new Error(JSON.stringify(j));
  console.log(`Telegram-бот: ВАЛИДЕН — @${j.result.username}`);
  if (!process.env.CC_TELEGRAM_CHANNEL) {
    console.log("  ⚠️ CC_TELEGRAM_CHANNEL пуст — алерты выключены, впиши id канала");
  }
} catch (e) {
  console.log(`Telegram-бот: FAIL — ${e.message?.slice(0, 200)}`);
  fail = true;
}

process.exit(fail ? 1 : 0);
