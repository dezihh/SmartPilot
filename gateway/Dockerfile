FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS deps
WORKDIR /app
COPY gateway/package.json gateway/package-lock.json ./
# better-sqlite3 13 ist ein N-API-Modul und bringt fertige Binaries (prebuilds/)
# mit. Ohne --ignore-scripts wuerde npm zusaetzlich node-gyp rebuild starten,
# das im slim-Image an fehlendem Python/gcc scheitert.
RUN npm ci --ignore-scripts

FROM deps AS build
COPY gateway/tsconfig.json ./
COPY gateway/src ./src
RUN npm run build

FROM deps AS dev
CMD ["npm", "run", "dev"]

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# gosu fuer den Privilegien-Wechsel im Entrypoint (siehe docker-entrypoint.sh).
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/*
COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
# Beispieldaten fuer den Erststart (SEED_PROFILE=example): nur die Manifeste,
# installiert wird ueber den normalen Paketpfad (Herkunft 'seed').
COPY packages/de/open-meteo-wetter/manifest.json /app/seed/open-meteo-wetter.manifest.json
COPY --from=build /app/dist ./dist
COPY gateway/web ./web
COPY gateway/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/data \
 && chown -R node:node /app
# Startet als root (um Bind-Mount-Rechte zu setzen) und wechselt danach zu
# 'node' (F-22): der Server laeuft nicht als root.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
