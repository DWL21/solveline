// Pages Functions(_worker.js)를 하나의 ES 모듈로 묶어 apps/web/dist/_worker.js에 쓴다(web 빌드가 복사한 원본을 덮어쓴다).
// Workers Free의 스크립트 크기(압축 3MB)를 넘지 않게 줄인다. Node 내장 모듈은 쓰지 않는다(쓰면 빌드가 실패한다).
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
if (!existsSync(dist)) throw new Error('apps/web/dist가 없습니다. web을 먼저 빌드하세요(pnpm --filter @solveline/web build).');
const out = `${dist}_worker.js`;
await build({
  entryPoints: [fileURLToPath(new URL('../src/worker-entry.ts', import.meta.url))],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
const gz = gzipSync(readFileSync(out)).length;
if (gz > 3 * 1024 * 1024) throw new Error(`_worker.js가 압축 3MB를 넘습니다(${gz}B)`);
console.log(`apps/web/dist/_worker.js: gzip ${(gz / 1024).toFixed(0)}KB`);
