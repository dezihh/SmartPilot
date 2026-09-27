#!/bin/sh
set -e

# Der Datenordner ist im Betrieb meist ein Host-Bind-Mount (./gateway/data) und
# gehoert dann root. Beim Start als root die Schreibrechte auf den App-User
# setzen und danach die Privilegien abgeben — so laeuft der Server nie als root
# (F-22). Laeuft der Container bereits als Nicht-root, wird nichts veraendert.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data 2>/dev/null || true
  exec gosu node "$@"
fi

exec "$@"
