// Одноразовый OCO для позиции-сироты PENGU (пост 5736, DECISIONS №88).
// Продажа 15914 PENGU: тейк 0.006334 (TP1 канала) ИЛИ стоп 0.006009/лимит 0.005980.
// Запуск владельцем: cd ~/dev/quant/backtest-ollama-crontab && node scripts/oco-pengu-5736.mjs
import "dotenv/config";
import ccxt from "ccxt";

const b = new ccxt.binance({
  apiKey: process.env.CC_BINANCE_API_KEY || process.env.BINANCE_API_KEY,
  secret: process.env.CC_BINANCE_API_SECRET || process.env.BINANCE_API_SECRET,
});

const legacy = {
  symbol: "PENGUUSDT", side: "SELL", quantity: "15914",
  price: "0.006334",
  stopPrice: "0.006009",
  stopLimitPrice: "0.005980",
  stopLimitTimeInForce: "GTC",
};

try {
  const r = await b.privatePostOrderOco(legacy);
  console.log("OCO OK: orderListId=", r.orderListId);
  for (const o of r.orderReports ?? []) console.log(" ", o.type, "price=", o.price, "stop=", o.stopPrice ?? "-", o.status);
} catch (e1) {
  console.log("legacy /order/oco не прошёл:", String(e1.message).slice(0, 140));
  const r = await b.privatePostOrderListOco({
    symbol: "PENGUUSDT", side: "SELL", quantity: "15914",
    aboveType: "LIMIT_MAKER", abovePrice: "0.006334",
    belowType: "STOP_LOSS_LIMIT", belowPrice: "0.005980",
    belowStopPrice: "0.006009", belowTimeInForce: "GTC",
  });
  console.log("OCO OK (orderList): orderListId=", r.orderListId);
  for (const o of r.orderReports ?? []) console.log(" ", o.type, "price=", o.price, "stop=", o.stopPrice ?? "-", o.status);
}
