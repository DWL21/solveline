import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@solveline/shared';
import { App } from './App.tsx';
import { ApiError, qk } from './lib/api.ts';
import './index.css';

// 앱을 화면에 실제로 보이는 영역에 맞춘다: 화상 키보드·브라우저 도구 막대가 나타나고 사라지면 높이와 위치가 바뀐다.
// 하단 실행 바가 키보드 바로 위·도구 막대 바로 위에 붙고, 아래에 빈 공간이 생기지 않는다.
const vv = window.visualViewport;
if (vv) {
  // 화상 키보드 열림: 지금까지 본 가장 큰 높이보다 150px 넘게 줄면 키보드로 본다(화면 회전 때 기준을 다시 잡는다)
  let tallest = vv.height;
  screen.orientation?.addEventListener('change', () => (tallest = 0));
  const root = document.documentElement;
  const fit = () => {
    tallest = Math.max(tallest, vv.height);
    if (vv.height < tallest - 150) root.dataset.keyboard = '';
    else delete root.dataset.keyboard;
    root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    // iOS는 키보드가 올라오면 보이는 영역을 문서 아래쪽으로 옮긴다 → 앱을 그 위치에 따라 붙인다
    root.style.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`);
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
