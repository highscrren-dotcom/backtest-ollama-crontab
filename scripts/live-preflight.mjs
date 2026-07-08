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
  const info = bal.info ?? {};
  const usdt = bal.USDT?.free ?? 0;
  console.log(`Binance: ключи ВАЛИДНЫ`);
  console.log(`  canTrade=${info.canTrade} canWithdraw=${info.canWithdraw} permissions=${JSON.stringify(info.permissions ?? [])}`);
  console.log(`  USDT free=${usdt}`);
  if (info.canTrade !== true) {
    console.log("  ⚠️ canTrade=false — включи Spot Trading в правах ключа");
    fail = true;
  }
  if (info.canWithdraw === true) {
    console.log("  ⚠️ canWithdraw=true — ВЫКЛЮЧИ вывод средств у этого ключа!");
    fail = true;
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
