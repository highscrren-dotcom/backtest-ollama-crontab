// Мостик для --brokerdebug (№118): CLI грузит modules/brokerdebug.module из cwd.
// Импорт регистрирует БОЕВОЙ адаптер и exchange-схему jan_2026 — brokerdebug
// стреляет одиночным commit'ом в него (критерий Петра: повторный signal-open
// обязан ответить «уже куплено», не купить снова).
import "../content/jan_2026.strategy/modules/live.module";
