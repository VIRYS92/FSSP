FROM node:24.19.0-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

RUN mkdir -p /var/lib/fssp/documents && chown -R node:node /var/lib/fssp

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "dist/server/server.js"]
