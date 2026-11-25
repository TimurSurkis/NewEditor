import { spawnSync } from 'node:child_process';
import electron from 'electron';
import { build } from 'vite';

// Существующие TS barrel-импорты разрешает Vite; нативные зависимости остаются
// внешними и загружаются настоящим Electron из node_modules проекта.
await build({
  configFile: false,
  publicDir: false,
  build: {
    ssr: true,
    outDir: 'out/native-tests',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    rollupOptions: {
      input: {
        'local-persistence.test': 'tests/native/local-persistence.test.ts',
        'save-journal.test': 'tests/native/save-journal.test.ts',
        'drafts-events.test': 'tests/native/drafts-events.test.ts',
        'save-crash-worker': 'tests/native/save-crash-worker.ts',
      },
      output: { entryFileNames: '[name].mjs' },
    },
  },
});

const result = spawnSync(
  electron,
  [
    '--experimental-strip-types',
    '--test',
    'tests/native/database.test.mjs',
    'out/native-tests/local-persistence.test.mjs',
    'out/native-tests/save-journal.test.mjs',
    'out/native-tests/drafts-events.test.mjs',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  },
);
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
