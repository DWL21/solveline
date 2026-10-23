import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@solveline/shared';
import { App } from './App.tsx';
import { ApiError, qk } from './lib/api.ts';
import './index.css';

const signedOut: Session = { authenticated: false, expiresAt: null, user: null };

/** 로그인이 풀렸거나(401) 이용이 정지되면(403 blocked) 세션을 끊고 로그인 화면으로 돌아간다. 관리자 모드의 401은 따로 다룬다. */
function onError(error: unknown) {
  if (!(error instanceof ApiError)) return;
  const lost = (error.status === 401 && error.code !== 'admin_required' && error.code !== 'invalid_password') || error.code === 'blocked';
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
