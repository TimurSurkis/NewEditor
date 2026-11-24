import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve('src/platform/desktop/main/index.ts'),
        external: ['better-sqlite3'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve('src/platform/desktop/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/platform/desktop/renderer'),
    plugins: [
      react(),
      {
        name: 'renderer-csp',
        transformIndexHtml: (html, context) => {
          const dev = Boolean(context.server);
          const policy = [
            "default-src 'none'",
            `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
            `style-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
            "img-src 'self' data:",
            "font-src 'self'",
            dev ? 'connect-src http://127.0.0.1:5173 ws://127.0.0.1:5173' : "connect-src 'none'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-src 'none'",
          ].join('; ');
          return html.replace('__CSP__', policy);
        },
      },
    ],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: { rollupOptions: { input: resolve('src/platform/desktop/renderer/index.html') } },
  },
});
