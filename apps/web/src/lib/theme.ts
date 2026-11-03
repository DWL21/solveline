import { useEffect, useState } from 'react';

/**
 * 화면 테마. html[data-theme]에 'dark' | 'light'를 둔다(index.css의 토큰이 이 값을 따른다).
 * 처음 값은 public/theme-init.js가 정한다(깜빡임 방지): 고른 적이 있으면 그 값, 없으면 기기 설정.
 * 직접 고르면 이 기기에 기억하고, 고르지 않았으면 기기 설정이 바뀔 때 따라간다.
 */
export type Theme = 'dark' | 'light';

export const THEME_KEY = 'solveline:theme';
const EVENT = 'solveline:theme';
const BAR_COLOR: Record<Theme, string> = { dark: '#1e1f22', light: '#ffffff' };

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

const systemTheme = (): Theme => (globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', BAR_COLOR[t]);
  globalThis.dispatchEvent(new Event(EVENT));
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    // 저장이 막힌 환경에서도 이번 화면에는 적용한다.
  }
  apply(t);
}

/** 현재 테마와 바꾸는 함수. 기기 설정 변경(직접 고른 적이 없을 때)과 다른 컴포넌트의 변경을 따라간다. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState(currentTheme);
  useEffect(() => {
    const on = () => set(currentTheme());
    const m = globalThis.matchMedia?.('(prefers-color-scheme: light)');
    const onSystem = () => {
      if (!stored()) apply(systemTheme());
    };
    globalThis.addEventListener(EVENT, on);
    m?.addEventListener('change', onSystem);
    return () => {
      globalThis.removeEventListener(EVENT, on);
      m?.removeEventListener('change', onSystem);
    };
  }, []);
  return [theme, setTheme];
}
