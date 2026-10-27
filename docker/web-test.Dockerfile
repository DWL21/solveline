# 테스트 환경 전용 웹: 운영에서 Cloudflare Pages(정적 파일) + API 게이트웨이(nginx)가 나눠 하는 일을 nginx 하나로 같은 출처에서 재현한다.
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @solveline/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @solveline/web build

FROM nginx:stable-alpine
COPY deploy/test/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
HEALTHCHECK --interval=5s --timeout=3s --retries=24 CMD wget -qO- http://127.0.0.1/api/health >/dev/null || exit 1
