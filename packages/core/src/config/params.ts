declare function parseInt(value: unknown): number;

export const CC_TELEGRAM_API_ID = parseInt(process.env.CC_TELEGRAM_API_ID) || 31861455;
export const CC_TELEGRAM_API_HASH = process.env.CC_TELEGRAM_API_HASH || "ca60446c67ce250ee4e789c730163449";

export const CC_OLLAMA_TOKEN = process.env.CC_OLLAMA_TOKEN || "";

// ФОРК-ПРАВКА: переключатель риск-гейта.
//  llm   — как в апстриме: Ollama Cloud (gpt-oss:120b) исполняет правила промптом;
//  rules — те же ПРАВИЛА 1-3 детерминированно, без LLM (для воспроизводимых
//          бэктестов и независимости live-очереди от аплинка Ollama);
//  off   — пропускать всё (гейт выключен).
export const CC_RISK_GATE = (process.env.CC_RISK_GATE || "llm") as
  | "llm"
  | "rules"
  | "off";

export const CC_REDIS_HOST = process.env.CC_REDIS_HOST || "127.0.0.1";
export const CC_REDIS_PORT = parseInt(process.env.CC_REDIS_PORT) || 6379;
export const CC_REDIS_USER = process.env.CC_REDIS_USER || "default";
export const CC_REDIS_PASSWORD = process.env.CC_REDIS_PASSWORD || "mysecurepassword";

export const CC_MONGO_CONNECTION_STRING = process.env.CC_MONGO_CONNECTION_STRING || "mongodb://localhost:27017/backtest-pro?wtimeoutMS=15000";

// ФОРК-ПРАВКА: список Telegram-каналов для скрейпа (через запятую). Каналы должны
// использовать шаблон сигналов семейства Crypto Yoda (SIGNAL_FORMAT в
// CryptoYodaScreenService); дедуп в Mongo — по (channel, messageId), поэтому
// пересечение messageId между каналами безопасно.
export const CC_CHANNEL_LIST = (process.env.CC_CHANNEL_LIST || "crypto_yoda_channel")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
