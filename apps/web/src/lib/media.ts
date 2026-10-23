import { useEffect, useState } from 'react';

/** CSS 미디어 쿼리 결과를 따라간다(화면 회전·창 크기 변경 포함) */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** 휴대폰 폭(태블릿 세로 768px 미만): 문제 화면을 탭으로 나눈다 */
export const useNarrow = () => useMediaQuery('(max-width: 767px)');
/** 손가락으로 쓰는 기기 */
export const useTouch = () => useMediaQuery('(pointer: coarse)');
