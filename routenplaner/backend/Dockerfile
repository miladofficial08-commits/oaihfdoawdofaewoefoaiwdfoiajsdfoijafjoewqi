# Eigenes Image für den Routenplaner. Railway baut daraus einen Dienst, der
# unabhängig vom Leadgen-Server im selben Repository läuft.
#
# Wichtig für Railway: "Root Directory" des Dienstes auf routenplaner stellen
# (nicht routenplaner/backend), denn der Build braucht auch shared/.
# Dockerfile-Pfad: backend/Dockerfile

FROM node:20-bookworm-slim

WORKDIR /app

# better-sqlite3 ist ein natives Modul und braucht beim Installieren
# Build-Werkzeug, falls für diese Plattform kein fertiges Binary vorliegt.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./backend/
WORKDIR /app/backend
RUN npm ci

WORKDIR /app
COPY shared ./shared
COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
COPY backend/tests ./backend/tests

WORKDIR /app/backend
RUN npm run build

# Die Tests laufen ohne Netz und ohne Datenbankdatei. Sie hier mitlaufen zu
# lassen kostet Sekunden und verhindert, dass ein kaputter Stand überhaupt
# erst deployt wird.
RUN node dist/backend/tests/run-tests.js

ENV NODE_ENV=production
EXPOSE 4100

CMD ["node", "dist/backend/src/server.js"]
