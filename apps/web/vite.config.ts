import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // 자주 바뀌지 않는 라이브러리는 따로 묶어, 앱 코드만 바뀐 배포에서도 브라우저 캐시를 그대로 쓴다.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/](@codemirror|@lezer|crelt|style-mod|w3c-keyname)[\\/]/.test(id)) return 'editor';
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (/[\\/]@tanstack[\\/]/.test(id)) return 'query';
          if (/[\\/]zod[\\/]/.test(id)) return 'zod';
        },
      },
    },
  },
  server: {
    host: true,
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    // 개발 중에는 같은 출처로 API를 프록시해 세션 쿠키가 그대로 붙게 한다.
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 8787}` },
  },
});
