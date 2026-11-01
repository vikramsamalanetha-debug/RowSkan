#!/bin/sh
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get the LTS version from https://nodejs.org"; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl was not found. Install it (macOS: it is built in; Linux: your package manager)."; exit 1; }
( sleep 2; (command -v open >/dev/null && open http://localhost:8080/) || (command -v xdg-open >/dev/null && xdg-open http://localhost:8080/) ) >/dev/null 2>&1 &
exec node server.js
