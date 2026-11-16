import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const { anchoredMenuStyle } = await import('./ui.jsx');

const viewport = { width: 800, height: 700 };
const rect = (left, top, w = 24, h = 24) => ({ left, top, right: left + w, bottom: top + h });

test('optional columns menu aligns to the toggle end edge and opens below when there is room', () => {
  assert.deepEqual(anchoredMenuStyle(rect(500, 100), viewport), { left: 334, top: 124, maxHeight: 572 });
  assert.deepEqual(anchoredMenuStyle(rect(500, 100), viewport, { rtl: true }), { left: 500, top: 124, maxHeight: 572 });
});

test('optional columns menu is clamped inside the viewport in both directions', () => {
  assert.equal(anchoredMenuStyle(rect(20, 100), viewport).left, 4);
  assert.equal(anchoredMenuStyle(rect(760, 100), viewport, { rtl: true }).left, 606);
});

test('optional columns menu opens upward near the bottom edge and caps its height', () => {
  assert.deepEqual(anchoredMenuStyle(rect(500, 620), viewport), { left: 334, bottom: 80, maxHeight: 616 });
});
