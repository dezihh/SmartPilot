FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# gosu fuer den Privilegien-Wechsel im Entrypoint (siehe docker-entrypoint.sh).
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
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

FROM deps AS dev
CMD ["npm", "run", "dev"]
