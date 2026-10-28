import { test, type Page } from '@playwright/test';
import { env } from './env.ts';

/**
 * 시연 모드(E2E_DEMO=1)에서만 화면을 증거로 남긴다. 이름은 QA 보고서의 그림 설명이 된다.
 * 평소 실행에서는 아무것도 하지 않아 속도와 아티팩트 크기에 영향이 없다.
 */
export async function evidence(page: Page, name: string) {
  if (!env.demo) return;
  const info = test.info();
  const path = info.outputPath(`evidence-${info.attachments.length + 1}.png`);
  await page.screenshot({ path });
  await info.attach(`evidence: ${name}`, { path, contentType: 'image/png' });
}
