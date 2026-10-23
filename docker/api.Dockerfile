FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod=false --filter @solveline/api...

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app /app
COPY packages/shared packages/shared
COPY apps/api apps/api
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data HOME=/tmp
WORKDIR /app/apps/api
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD curl -fsS http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "--import", "tsx", "src/main.ts"]
