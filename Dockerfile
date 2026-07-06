FROM node:22-bookworm-slim

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY README.md ./
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
