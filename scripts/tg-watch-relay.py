#!/usr/bin/env python3
"""Stop-хук: дублирует в телегу владельцу ФИНАЛЬНЫЙ ответ ассистента, НО только
если текущий turn инициирован ТАЙМЕРОМ/МОНИТОРОМ (фоновое событие), а не живым
сообщением владельца. Так «вахта» видна на телефоне, а интерактивный чат — нет.

Вход: JSON на stdin (harness Stop-хук) с полем transcript_path.
Токен — из боевого .env (CC_TELEGRAM_TOKEN), чат — личка владельца
(ALLOWED_CHAT_ID из .env моста). Секреты редактируются. Всегда exit 0 —
хук не должен ронять/блокировать сессию.
"""
import json
import os
import sys
import urllib.request
import urllib.parse

DRY = os.environ.get("TG_RELAY_DRY") == "1"

COMBAT_ENV = "/home/s1dd1/dev/quant/backtest-ollama-crontab/.env"
BRIDGE_ENV = "/home/s1dd1/dev/quant/tg-claude-bridge/.env"

# Маркеры фонового/таймерного turn'а (НЕ живой ввод владельца).
BG_MARKERS = (
    "<task-notification>",
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "Дежурный 2ч-тик",
    "<<autonomous-loop",
)


def parse_env(path):
    d = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    d[k.strip()] = v.strip()
    except Exception:
        pass
    return d


def text_of(content):
    """Достаёт человеческий текст из message.content (строка или массив блоков)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text", ""))
        return "\n".join(parts)
    return ""


def is_tool_result(content):
    return isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in content
    )


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    tpath = payload.get("transcript_path")
    if not tpath:
        return

    try:
        with open(tpath) as f:
            lines = [l for l in f if l.strip()]
    except Exception:
        return

    entries = []
    for l in lines:
        try:
            entries.append(json.loads(l))
        except Exception:
            pass

    # Последний ответ ассистента (финальный текст turn'а).
    assistant_text = ""
    for e in reversed(entries):
        if e.get("type") == "assistant":
            t = text_of(e.get("message", {}).get("content"))
            if t.strip():
                assistant_text = t.strip()
                break

    # Инициатор turn'а: последнее ЧЕЛОВЕКО-читаемое user-сообщение (не tool_result).
    trigger_text = ""
    for e in reversed(entries):
        if e.get("type") == "user":
            content = e.get("message", {}).get("content")
            if is_tool_result(content):
                continue
            trigger_text = text_of(content)
            if trigger_text.strip():
                break

    if not assistant_text or not trigger_text:
        return

    # Только фоновые/таймерные turn'ы — интерактивный чат НЕ дублируем.
    if not any(m in trigger_text for m in BG_MARKERS):
        if DRY:
            print(f"SKIP (интерактив): trigger[:40]={trigger_text[:40]!r}")
        return
    if DRY:
        print(f"WOULD SEND: trigger маркер найден; ответ[:60]={assistant_text[:60]!r}")
        return

    combat = parse_env(COMBAT_ENV)
    bridge = parse_env(BRIDGE_ENV)
    token = combat.get("CC_TELEGRAM_TOKEN")
    chat = bridge.get("ALLOWED_CHAT_ID")
    if not token or not chat:
        return

    # Редакция секретов (значения токенов/ключей боевого .env → [СКРЫТО]).
    secrets = [v for k, v in combat.items()
               if any(s in k.upper() for s in ("TOKEN", "KEY", "SECRET", "PASSWORD"))
               and len(v) >= 8]
    msg = assistant_text
    for s in sorted(secrets, key=len, reverse=True):
        msg = msg.replace(s, "[СКРЫТО]")

    msg = "🛰 вахта (таймер):\n\n" + msg
    if len(msg) > 3900:
        msg = msg[:3900] + "\n…(обрезано)"

    data = urllib.parse.urlencode({"chat_id": chat, "text": msg}).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage", data=data
    )
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    finally:
        sys.exit(0)  # хук НИКОГДА не должен блокировать сессию
