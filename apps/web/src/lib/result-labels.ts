import type { Language } from '@solveline/shared';

/** 실행 전 검사가 실패했을 때의 제목. Java는 javac 컴파일, Python은 컴파일 단계 없이 문법만 검사한다(py_compile). */
export function prepareErrorLabel(language: Language): string {
  return language === 'python' ? '문법 에러' : '컴파일 에러';
}
