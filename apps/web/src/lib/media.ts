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

/**
 * 휴대폰 배치: 폭 768px 미만(세로 휴대폰·폴더블 접은 화면), 또는 터치 기기의 낮은 화면(가로로 눕힌 휴대폰).
 * 가로 휴대폰은 폭이 넓어도 높이가 낮아 좌우 분할에 키보드까지 올라오면 코드가 거의 안 보인다.
 */
export const useNarrow = () => useMediaQuery('(max-width: 767px), (pointer: coarse) and (max-height: 500px)');
/** 손가락으로 쓰는 기기 */
export const useTouch = () => useMediaQuery('(pointer: coarse)');
