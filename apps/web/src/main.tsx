import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@codetest/shared';
import { App } from './App.tsx';
import { ApiError, qk } from './lib/api.ts';
import './index.css';

const signedOut: Session = { authenticated: false, expiresAt: null };

/** 어느 요청이든 401이면 세션을 끊고 로그인 화면으로 돌아간다 */
function onError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
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
