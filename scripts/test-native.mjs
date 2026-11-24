import { spawnSync } from 'node:child_process';
import electron from 'electron';

const result = spawnSync(
  electron,
  ['--experimental-strip-types', '--test', 'tests/native/database.test.mjs'],
  {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  },
);
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
