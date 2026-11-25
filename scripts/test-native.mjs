import { spawnSync } from 'node:child_process';
import electron from 'electron';
import { build } from 'vite';

// Существующие TS barrel-импорты разрешает Vite; нативные зависимости остаются
// внешними и загружаются настоящим Electron из node_modules проекта.
await build({
  configFile: false,
  publicDir: false,
  build: {
    ssr: 'tests/native/local-persistence.test.ts',
    outDir: 'out/native-tests',
    emptyOutDir: false,
    target: 'node24',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'local-persistence.test.mjs' } },
  },
});

const result = spawnSync(
  electron,
  [
    '--experimental-strip-types',
    '--test',
    'tests/native/database.test.mjs',
    'out/native-tests/local-persistence.test.mjs',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  },
);
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
