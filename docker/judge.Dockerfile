# 채점 서비스(judge): 제출 대기열·디스패처·테스트셋 캐시. runner만 부르고 사용자 데이터는 두지 않는다(0007).
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/judge/package.json apps/judge/
RUN pnpm install --frozen-lockfile --prod=false --filter @solveline/judge...

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app /app
COPY packages/shared packages/shared
COPY apps/judge apps/judge
ENV NODE_ENV=production PORT=8790 DATA_DIR=/data HOME=/tmp
WORKDIR /app/apps/judge
USER node
EXPOSE 8790
HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD curl -fsS http://127.0.0.1:8790/health || exit 1
CMD ["node", "--import", "tsx", "src/main.ts"]
