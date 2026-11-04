// Node ESM loader that transforms .jsx files on the fly with esbuild for testing React components.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.jsx')) {
    const raw = await readFile(fileURLToPath(url), 'utf8');
    const { code } = await transform(raw, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    return {
      format: 'module',
      shortCircuit: true,
      source: code,
    };
  }
  return nextLoad(url, context);
}
