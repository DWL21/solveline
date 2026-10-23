# API 게이트웨이. 프론트 정적 파일은 Cloudflare Pages에서 제공한다.
FROM nginx:stable-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.conf /etc/nginx/snippets/security-headers.conf
