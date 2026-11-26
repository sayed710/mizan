import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMoveHash, secureMoveInvariant, SECURED_ORDER_ERROR } from './models/hash_chain.js';

function fixture() {
  const moves = [];
  let previous = '';
  for (let i = 1; i <= 12; i++) {
    const move = { id: i, company_id: 1, state: 'posted', name: `A/${String(i).padStart(3, '0')}`, secure_sequence_number: i };
    move.inalterable_hash = computeMoveHash(move, previous);
    previous = move.inalterable_hash;
    moves.push(move);
  }
  return { records: { 'account.move': moves, 'account.journal': [{ id: 1, secure_chain_heads: [{ company_id: 1, last_move_id: 12, last_hash: previous }] }] } };
}

function countHashes(fn) {
  const Original = globalThis.TextEncoder;
  let count = 0;
  globalThis.TextEncoder = class extends Original { encode(value) { count++; return super.encode(value); } };
  try { fn(); return count; } finally { globalThis.TextEncoder = Original; }
}

test('draft invoice invariant does not hash an unrelated legacy chain', () => {
  const db = fixture();
  const invoice = { id: 13, state: 'draft', journal_id: 1, company_id: 1 };
  assert.equal(countHashes(() => assert.equal(secureMoveInvariant(db, invoice, null), null)), 0);
});

test('legacy ownership is computed once and reused for stable staged records', () => {
  const db = fixture();
  const cache = {};
  const posted = { id: 13, state: 'posted', journal_id: 1, company_id: 1, name: 'A/001' };
  assert.equal(countHashes(() => {
    assert.equal(secureMoveInvariant(db, posted, null, cache), SECURED_ORDER_ERROR);
    assert.equal(secureMoveInvariant(db, posted, null, cache), SECURED_ORDER_ERROR);
  }), 11);
  const changed = { ...db, records: { ...db.records } };
  assert.equal(countHashes(() => assert.equal(secureMoveInvariant(changed, posted, null, cache), SECURED_ORDER_ERROR)), 11);
});
