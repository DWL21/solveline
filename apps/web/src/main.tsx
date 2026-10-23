import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@solveline/shared';
import { App } from './App.tsx';
import { ApiError, qk } from './lib/api.ts';
import './index.css';

// 화상 키보드가 올라오면 보이는 높이가 줄어든다. 앱 높이를 거기에 맞춰 하단 실행 바·코딩 키가 키보드 바로 위에 오게 한다.
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    // iOS는 키보드가 올라올 때 문서를 밀어 올린다 → 화면 높이에 고정된 화면(문제 풀이 등)이면 맨 위로 되돌린다
    const fixedLayout = document.documentElement.scrollHeight <= window.innerHeight + 1;
    if (fixedLayout && window.scrollY) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

const signedOut: Session = { authenticated: false, expiresAt: null, user: null };

/** 로그인이 풀리면(401) 세션을 끊고 로그인 화면으로 돌아간다. 관리자 모드의 401은 따로 다룬다. */
function onError(error: unknown) {
  if (!(error instanceof ApiError)) return;
  const lost = (error.status === 401 && error.code !== 'admin_required' && error.code !== 'invalid_password');
  // 이미 비회원이면 아무것도 하지 않는다(쿼리를 지우면 다시 요청해 401이 반복된다)
  if (lost && client.getQueryData<Session>(qk.session)?.authenticated) {
    client.setQueryData(qk.session, signedOut);
    client.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.session[0] });
  }
}

const client: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (n, e) => !(e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404 || e.status === -1)) && n < 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
