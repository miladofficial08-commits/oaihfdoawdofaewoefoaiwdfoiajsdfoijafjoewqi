# Eigenes Image für den Routenplaner. Railway baut daraus einen Dienst, der
# unabhängig vom Leadgen-Server im selben Repository läuft.
#
# Wichtig für Railway: "Root Directory" des Dienstes auf routenplaner/backend
# stellen, sonst nimmt Railway das Dockerfile im Repository-Wurzelverzeichnis.

FROM node:20-bookworm-slim

WORKDIR /app

# better-sqlite3 ist ein natives Modul und braucht beim Installieren
# Build-Werkzeug, falls für diese Plattform kein fertiges Binary vorliegt.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build

# Die Tests laufen ohne Netz und ohne Datenbankdatei. Sie hier mitlaufen zu
# lassen kostet Sekunden und verhindert, dass ein kaputter Stand überhaupt
# erst deployt wird.
RUN node dist/tests/run-tests.js

ENV NODE_ENV=production
EXPOSE 4100

CMD ["node", "dist/src/server.js"]
