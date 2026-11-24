import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('../node_modules/playwright/cli.js', import.meta.url)), 'test'],
  { stdio: 'inherit', env: { ...process.env, NEWEDITOR_TEST_DEV: '1' } },
);
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
