# Backend image. Build from the REPO ROOT (the server imports packages/shared from outside apps/server):
#   docker build -f deploy/server.Dockerfile -t vouch-api .
# Node 24: the server uses the built-in node:sqlite.
FROM node:24-slim

# Posting runs `bankr x402 deploy`, so the Bankr CLI ships in the image. Log in once inside the running
# container (see README); its login lives under HOME, which points at the volume so it survives restarts.
RUN npm install -g @bankr/cli && npm cache clean --force

WORKDIR /app
COPY apps/server/package.json apps/server/package-lock.json apps/server/
# --ignore-scripts: utf-8-validate (an optional native speed-up for ws) needs a compiler this slim image lacks;
# it falls back to plain JS. esbuild (tsx) ships prebuilt binaries and needs no install script.
RUN npm --prefix apps/server ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/server apps/server

# /data is the volume: the SQLite database and the Bankr CLI login. Owned by the unprivileged user so a fresh
# named volume inherits that ownership.
RUN mkdir -p /data/home && chown -R node:node /data /app
USER node

ENV NODE_ENV=production \
    HOME=/data/home \
    DB_PATH=/data/vouch.db \
    X402_WORKDIR=/tmp/x402-build \
    PORT=8787
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/index.ts"]
