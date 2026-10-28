import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed } from '../src/seed.js';
import { openStorage } from './storage.js';
import { log } from './log.js';

test('a failing scheduled job logs a structured error to stderr on server start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-sched-log-'));
  const dbPath = join(dir, 'db.sqlite');
  const sql = new DatabaseSync(dbPath);
  const storage = openStorage(sql);
  const s = seed();
  // A referral pointing to a non-existent applicant makes syncFromApplicant throw.
  const broken = {
    ...s,
    records: {
      ...s.records,
      'hr.referral': [{ id: 999, applicant_id: 424242 }],
    },
  };
  storage.save(null, broken);
  sql.close();

  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '0', MIZAN_DB: dbPath, MIZAN_ADMIN_PASSWORD: 'sched-admin-pw' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const errLinePromise = new Promise((resolve, reject) => {
    let buf = '';
    child.stderr.on('data', (d) => {
      buf += String(d);
      for (const line of buf.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.level === 'error' && parsed.msg === 'scheduled job failed') {
            resolve(parsed);
          }
        } catch {
          // Ignore non-JSON lines on stderr
        }
      }
    });
    child.on('exit', (code) => {
      reject(new Error(`Server exited unexpectedly with code ${code} without logging scheduled job error`));
    });
  });

  try {
    const errorLog = await errLinePromise;
    assert.equal(errorLog.level, 'error');
    assert.equal(errorLog.msg, 'scheduled job failed');
    assert.equal(errorLog.job, 'syncFromApplicant');
    assert.match(errorLog.error?.message, /hr\.applicant record not found/);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.send('shutdown');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('log structured error format includes job and serialized error', () => {
  const originalStderrWrite = process.stderr.write;
  let written = '';
  process.stderr.write = (chunk) => {
    written += chunk;
    return true;
  };
  try {
    const err = new Error('simulated failure');
    log('error', 'scheduled job failed', { job: 'syncFromApplicant', error: err });
    const parsed = JSON.parse(written.trim());
    assert.equal(parsed.level, 'error');
    assert.equal(parsed.msg, 'scheduled job failed');
    assert.equal(parsed.job, 'syncFromApplicant');
    assert.equal(parsed.error.message, 'simulated failure');
    assert.ok(parsed.error.stack);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});
