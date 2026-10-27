import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 테스트 환경 설정. scripts/test-env.sh가 만든 e2e/.env.local(테스트마다 새로 만든 임의 값)을 읽는다.
 * 비밀 값은 저장소에 두지 않고, 출력하지 않는다.
 */
const local = fileURLToPath(new URL('../.env.local', import.meta.url));
if (existsSync(local)) {
  for (const line of readFileSync(local, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
  }
}

export const env = {
  /** 테스트 대상. 기본은 Docker 테스트 환경 */
  baseURL: process.env.E2E_BASE_URL ?? `http://${process.env.SERVICE_HOST ?? 'localhost'}:${process.env.E2E_PORT ?? 8090}`,
  /** 운영 스모크 대상(읽기 전용 검사만) */
  productionURL: process.env.E2E_PRODUCTION_URL ?? 'https://solveline.simplyimg.com',
  testAuthToken: process.env.E2E_TEST_AUTH_TOKEN ?? '',
  masterPassword: process.env.E2E_MASTER_PASSWORD ?? '',
  ci: !!process.env.CI,
};
