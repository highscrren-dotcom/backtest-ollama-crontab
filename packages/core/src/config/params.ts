declare function parseInt(value: unknown): number;

// ФОРК-ПРАВКА (см. README-FORK.md): дефолтные Telegram-креды апстрима (чужие
// api_id/api_hash автора) удалены. Получи СВОИ на https://my.telegram.org
// и пропиши в .env; используй отдельный аккаунт (MTProto user-session = риск бана).
export const CC_TELEGRAM_API_ID = parseInt(process.env.CC_TELEGRAM_API_ID) || 0;
export const CC_TELEGRAM_API_HASH = process.env.CC_TELEGRAM_API_HASH || "";

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
