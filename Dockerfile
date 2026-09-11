# Node 24 "slim" (Debian): o driver do libsql (Turso) e um modulo nativo, e
# o Debian tem prebuild pra tudo - no Alpine (musl) as vezes falta e o build
# quebra. Alguns MB a mais de imagem, muito menos dor de cabeca.
FROM node:24-slim

# O libsql (Rust) usa o "trust store" do sistema para o TLS com o Turso, e a
# imagem slim nao traz os certificados raiz. Sem isto: "TLS error: no valid
# native root CA certificates found" e o servidor nao sobe.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Somente o package.json: o lock fica de fora de proposito, para o build nao
# quebrar quando ele estiver defasado em relacao as dependencias.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error

# So o que o servidor precisa para rodar. A pasta scripts/ (checar, testes,
# publicar) e ferramenta de linha de comando: fica de fora de proposito, para
# uma pasta ausente no repositorio nunca derrubar o build.
COPY server ./server
COPY web ./web
COPY start.js ./

ENV PORT=3000
ENV NAO_ABRIR=1
# No servidor quem responde pela internet e o dominio, nao um tunel.
ENV TUNEL_AUTOMATICO=false
# O banco vive aqui. Monte o volume da hospedagem NESTE caminho, senao cada
# deploy comeca do zero. Se preferir outro, mude tambem a variavel DATA_DIR.
ENV DATA_DIR=/app/data

EXPOSE 3000

# Sem VOLUME e sem HEALTHCHECK de proposito: a hospedagem monta o proprio
# volume e faz a propria checagem, e declarar os dois aqui so cria conflito.
CMD ["node", "start.js"]
