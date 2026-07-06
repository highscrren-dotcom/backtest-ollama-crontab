declare function parseInt(value: unknown): number;

// ФОРК-ПРАВКА (см. README-FORK.md): дефолтные чужие креды апстрима удалены —
// задай свои с https://my.telegram.org в .env.
export const CC_TELEGRAM_API_ID = parseInt(process.env.CC_TELEGRAM_API_ID) || 0;
export const CC_TELEGRAM_API_HASH = process.env.CC_TELEGRAM_API_HASH || "";

function parseSymbolList(envVar: string, fallback: string) {
  const originList = process.env[envVar] || fallback;
  return originList
    .split(",")
    .map((s) => s.trim());
}

export const CC_SYMBOL_LIST = parseSymbolList(
    "CC_SYMBOL_LIST",
    "BTCUSDT,POLUSDT,ZECUSDT,HYPEUSDT,DOGEUSDT,SOLUSDT,PENGUUSDT,TRXUSDT,HBARUSDT,NEARUSDT,FARTCOINUSDT,ETHUSDT,PUMPUSDT"
);
