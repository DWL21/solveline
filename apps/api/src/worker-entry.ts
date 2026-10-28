// scripts/build-worker.mjs가 이 파일을 하나로 묶어 apps/web/dist/_worker.js를 만든다(Pages Functions).
// 카탈로그 캐시·R2 프록시(apps/web/public/_worker.js)에 Worker용 API(worker.ts)를 붙인다. API는 API_MODE=worker이고 DB 바인딩이 있을 때만 쓴다.
// @ts-expect-error -- 타입 선언이 없는 JS 모듈(Pages Worker 원본)
import { createWorker } from '../../web/public/_worker.js';
import { handleApi } from './worker.ts';

export default createWorker(handleApi);
