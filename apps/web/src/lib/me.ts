import { useQuery } from '@tanstack/react-query';
import { api, qk } from './api.ts';

/** 로그인한 사용자(없으면 null). 세션은 App이 먼저 불러 두므로 캐시에서 바로 읽힌다. */
export function useMe() {
  return useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Infinity }).data?.user ?? null;
}

/** 로그인 화면 주소. 로그인한 뒤 지금 보던 화면으로 돌아온다. */
export const loginHref = () => `/login?next=${encodeURIComponent(location.hash ? `/${location.hash}` : '/')}`;
