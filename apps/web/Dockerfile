# syntax=docker/dockerfile:1

FROM node:22.13.1-bookworm-slim AS build

ARG PNPM_VERSION=11.19.0

RUN npm install --global "pnpm@${PNPM_VERSION}"

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json tsconfig.test.json ./
COPY packages/provider-contracts/package.json packages/provider-contracts/package.json
COPY apps/web/package.json apps/web/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

COPY packages/provider-contracts packages/provider-contracts
COPY apps/web apps/web

RUN pnpm web:build

FROM build AS qa

ARG PLAYWRIGHT_VERSION=1.63.0

USER root

RUN apt-get update && \
    apt-get install --yes --no-install-recommends python3 python3-venv && \
    rm -rf /var/lib/apt/lists/* && \
    python3 -m venv /opt/optimizer-venv

COPY services/optimizer/requirements.txt /tmp/optimizer-requirements.txt
RUN /opt/optimizer-venv/bin/python -m pip install --no-cache-dir --requirement /tmp/optimizer-requirements.txt

RUN npm install --global "playwright@${PLAYWRIGHT_VERSION}" && \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright playwright install --with-deps chromium

COPY services/optimizer services/optimizer
COPY scripts scripts
COPY algorithm-research/benchmark/datasets/problem.json algorithm-research/benchmark/datasets/problem.json

ENV OPTIMIZER_TEST_PYTHON=/opt/optimizer-venv/bin/python \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_MODULE_PATH=/usr/local/lib/node_modules/playwright

CMD ["pnpm", "qa", "--browser"]

FROM node:22.13.1-bookworm-slim AS runtime

ARG WRANGLER_VERSION=4.92.0

RUN apt-get update && \
    apt-get install --yes --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    npm install --global "wrangler@${WRANGLER_VERSION}" && \
    npm cache clean --force && \
    mkdir -p /app /data && \
    chown -R node:node /app /data

WORKDIR /app

COPY --from=build --chown=node:node /workspace/apps/web/dist ./dist

ENV CI=true \
    NODE_ENV=production \
    CLOUDFLARE_INCLUDE_PROCESS_ENV=true \
    WRANGLER_SEND_METRICS=false \
    WRANGLER_WRITE_LOGS=false

USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/mobile/v1/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["wrangler", "dev", "--config", "dist/server/wrangler.json", "--ip", "0.0.0.0", "--port", "3000", "--persist-to", "/data", "--log-level", "info"]
