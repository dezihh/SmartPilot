FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 13 ist ein N-API-Modul und bringt fertige Binaries (prebuilds/)
# mit. Ohne --ignore-scripts wuerde npm zusaetzlich node-gyp rebuild starten,
# das im slim-Image an fehlendem Python/gcc scheitert.
RUN npm ci --ignore-scripts

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM deps AS dev
CMD ["npm", "run", "dev"]

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# gosu fuer den Privilegien-Wechsel im Entrypoint (siehe docker-entrypoint.sh).
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY web ./web
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/data \
 && chown -R node:node /app
# Startet als root (um Bind-Mount-Rechte zu setzen) und wechselt danach zu
# 'node' (F-22): der Server laeuft nicht als root.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
