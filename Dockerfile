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

ENV TZ=Asia/Yekaterinburg

CMD ["bash", "deploy/run-live.sh"]
