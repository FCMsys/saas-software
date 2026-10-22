# FC M:sys – keine npm-Abhängigkeiten, daher ein schlankes Image ohne Build-Schritt
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

COPY package.json ./
COPY server.js random.html ./
COPY src/img ./src/img
COPY src/design.js ./src/design.js
COPY src/logic ./src/logic

# Lokaler Speicher (nur genutzt, wenn Supabase_* nicht gesetzt ist); gehört dem unprivilegierten Benutzer
RUN mkdir -p /app/daten/fotos && chown -R node:node /app
USER node

EXPOSE 3000

# /healthz antwortet ohne Login und ohne Host-Prüfung
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "server.js"]
