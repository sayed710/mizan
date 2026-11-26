import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL('..', import.meta.url);
const LISTENING_RE = /Mizan listening on (http:\/\/(?:localhost|127\.0\.0\.1):[1-9]\d*)(?=\s)/;

/**
 * Gracefully ask `child` to exit over IPC, tolerating only ERR_IPC_CHANNEL_CLOSED (which can happen when
 * `child.connected` is still true before the parent reads IPC EOF). If the channel is gone while the process
 * is still alive, kill it and wait for `close` so the server never outlives the test before dir removal.
 */
export async function stopChild(child, isClosed = () => false) {
  if (!child || isClosed()) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    if ((child.stdio ?? []).some((s) => s && !s.destroyed)) await once(child, 'close');
    return;
  }
  const closed = once(child, 'close');
  let channelClosed = !child.connected;
  let sendError = null;
  try {
    if (child.connected) {
      await new Promise((resolve) => {
        child.send('shutdown', (err) => {
          if (err?.code === 'ERR_IPC_CHANNEL_CLOSED') channelClosed = true;
          else if (err) sendError = err;
          resolve();
        });
      });
    }
  } finally {
    if ((channelClosed || !child.connected || sendError) && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await closed;
  }
  if (sendError) throw sendError;
}

/**
 * Spawn `server/index.js` with the given `env` and optional `--import` `preload`, resolve with
 * `{ child, origin, url, output, stderr, stop }` as soon as the listening line appears,
 * or reject immediately on exit/error or after `timeoutMs` (default 60 s).
 */
export async function startServer({ env = process.env, preload, timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS, cwd = REPO_ROOT } = {}) {
  const preloadHref = preload
    ? (preload instanceof URL ? preload.href : /^(file|data):/.test(String(preload)) ? String(preload) : pathToFileURL(preload).href)
    : null;
  const args = [...(preloadHref ? ['--import', preloadHref] : []), 'server/index.js'];
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });

  let output = '';
  let stderr = '';
  let closed = false;
  child.once('close', () => { closed = true; });

  const origin = await waitForListening().catch(async (err) => {
    // Never hand back a failed start while the process may still hold the caller's temp directory.
    err.child = child;
    // stopChild kills and awaits `close` even when the IPC shutdown fails; keep that failure on the startup error.
    await stopChild(child, () => closed).catch((stopErr) => { err.cause ??= stopErr; });
    throw err;
  });

  function waitForListening() { return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onStdout = (chunk) => {
      output += chunk;
      if (settled) return;
      const match = LISTENING_RE.exec(output);
      if (match) succeed(match[1]);
    };
    const onStderr = (chunk) => {
      const text = String(chunk);
      output += text;
      stderr += text;
    };
    const onError = (err) => fail(err);
    const onExit = (code, signal) => {
      const err = new Error(`Server exited with code ${code}${signal ? ` (${signal})` : ''}: ${output}`);
      Object.assign(err, { exited: true, code, signal, output, stderr });
      fail(err);
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      const err = new Error(`Server did not start within ${timeoutMs}ms: ${output}`);
      Object.assign(err, { timedOut: true, output, stderr });
      fail(err);
    }, timeoutMs);

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  }); }

  return {
    child,
    origin,
    url: origin,
    get output() { return output; },
    get stderr() { return stderr; },
    stop: () => stopChild(child, () => closed),
  };
}
