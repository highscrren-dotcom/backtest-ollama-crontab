# Рантайм live-движка jan_2026 + крон-контейнера вахты (Coolify).
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bash procps \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /usr/local/bin/supercronic \
      https://github.com/aptible/supercronic/releases/download/v0.2.33/supercronic-linux-amd64 \
 && chmod +x /usr/local/bin/supercronic

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# packages/{core,main}/build/*.cjs гитигнорены (артефакты rollup) — собираем в образе;
# их require'ит config/alias.config.ts, без них движок падает на загрузке конфига.
# как scripts/linux/build.sh (без dotenv): npm install внутри пакета ставит его
# deps (telegram, qrcode-terminal и др.), затем rollup-сборка
RUN cd packages/core && npm install --no-audit --no-fund && npm run build \
 && cd ../main && npm install --no-audit --no-fund && npm run build

ENV TZ=Asia/Yekaterinburg

CMD ["bash", "deploy/run-live.sh"]
