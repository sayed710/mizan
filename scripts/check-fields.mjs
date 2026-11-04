// Runs the test suite with the ORM refusing any write of a field the model does not declare (the server would
// silently drop it). Usage: npm run test:fields
import { spawnSync } from 'node:child_process';

const run = spawnSync(process.execPath, ['--test', 'src/**/*.test.js', 'server/**/*.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, MIZAN_STRICT_FIELDS: '1' },
});
process.exit(run.status ?? 1);
