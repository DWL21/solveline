# Pages 프론트 배포

프론트만 Cloudflare Pages의 Direct Upload 프로젝트 `solveline`로 배포합니다. API·SQLite·채점 runner는 기존 pahidc에 그대로 둡니다. `web` compose 서비스 이름은 유지하지만 이미지는 정적 파일 없이 API nginx 게이트웨이만 제공합니다.

## CI/CD

- PR: 기존 `check`(타입·테스트·빌드), `docker`(이미지·격리 검사), `secret-scan` 유지.
- main: 기존 `deploy.yml`의 self-hosted runner가 web을 빌드하고 서버 이미지를 먼저 배포한 다음 `apps/web/dist`만 Wrangler로 Pages에 업로드합니다. 새 API가 준비되기 전에 새 프론트가 노출되지 않도록 기존 API의 하위 호환성을 유지합니다.
- 프론트 빌드가 실패하면 서버 배포를 시작하지 않습니다. Pages 업로드가 실패하면 기존 프론트 배포가 유지됩니다. Pages의 Git 자동 빌드는 연결하지 않아 중복 배포를 막습니다.
- 배포 runner의 기존 Wrangler 인증을 사용합니다(같은 서버의 Pages 배포와 동일). 인증이 만료되면 해당 OS 사용자로 Wrangler 인증을 갱신합니다. 인증 파일·토큰은 출력하거나 저장소에 넣지 않습니다.
- production 환경·main/repository 제한·배포 동시성 제어를 유지합니다.

## 최초 전환

1. 기존 Tunnel에 `solveline-api.simplyimg.com → http://127.0.0.1:8083` 경로와 DNS를 추가합니다. 공개 `/api/health`가 정상인지 확인합니다.
2. Pages 프로젝트 `solveline`(production branch `main`)를 만들고 web 빌드 결과를 업로드합니다.
3. Pages에 사용자 지정 도메인 `solveline.simplyimg.com`을 등록하고 기존 Tunnel CNAME을 프로젝트의 `*.pages.dev` 주소로 변경합니다. Pages의 실제 프로젝트 도메인을 사용합니다.
4. `/`, `/signup`, `/api/health`, Google 로그인 리다이렉트를 확인한 뒤 서버를 API 게이트웨이 이미지로 전환합니다.

`WEB_ORIGIN`과 Google 승인 리디렉션 URI `https://solveline.simplyimg.com/api/auth/google/callback`은 변경하지 않습니다. 브라우저는 같은 출처 `/api/*`를 호출하므로 기존 쿠키·CORS·CSP 설정을 유지합니다. Pages 프록시는 리디렉션을 직접 따라가지 않고 쿠키를 그대로 전달하며 API 응답을 캐시하지 않습니다. 미리보기 도메인은 헬스 체크 외 운영 API를 차단합니다.

정적 파일 보안 헤더는 `_headers`, API 보안 헤더는 기존 API 게이트웨이가 적용합니다. `_routes.json`으로 API만 Function을 거치게 합니다. SPA 경로는 Pages 기본 fallback을 사용합니다.

## 롤백

- 프론트만 문제가 있으면 Pages의 이전 정상 production 배포로 롤백합니다. API 호환성을 먼저 확인합니다.
- 서버 nginx로 완전히 되돌리려면 전환 전 커밋의 web 이미지를 다시 빌드·배포하고 로컬 웹·API를 확인한 다음, 도메인 CNAME을 기존 Tunnel 대상으로 되돌립니다. 프론트가 없는 새 게이트웨이에 DNS만 돌리면 안 됩니다.
- DB와 테스트셋은 이전 대상이 아니며 삭제하지 않습니다.
