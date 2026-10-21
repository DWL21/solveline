import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    // 개발 중에는 같은 출처로 API를 프록시해 세션 쿠키가 그대로 붙게 한다.
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 8787}` },
  },
});
