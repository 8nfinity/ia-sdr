# Node 24: traz o SQLite embutido (node:sqlite) sem precisar compilar nada.
FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY web ./web
COPY scripts ./scripts
COPY start.js ./

# O banco fica em /app/data - monte um volume aqui, senao voce perde os
# leads e o historico a cada atualizacao do container.
VOLUME /app/data

ENV PORT=3000
ENV NAO_ABRIR=1
# No servidor quem responde pela internet e o dominio, nao um tunel: subir o
# cloudflared aqui so criaria um endereco paralelo e confuso.
ENV TUNEL_AUTOMATICO=false
ENV DATA_DIR=/app/data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "start.js"]
