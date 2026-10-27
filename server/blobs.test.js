// Uploaded files move out of records into the blobs table, so they do not count toward the database size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { create, read } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { cleanValue } from '../src/validate.js';
import { openBlobs } from './blobs.js';
import { safeImage } from './api.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 receipt').toString('base64')}`;

test('externalize stores inline files once and leaves records without inline data untouched', () => {
  const blobs = openBlobs(new DatabaseSync(':memory:'));
  const base = seed();
  assert.equal(blobs.externalize(base), base);
  const { db, id } = create(base, 'hr.expense', { name: 'Taxi', employee_id: 1, receipt: { name: 'r.pdf', type: 'application/pdf', size: 16, data: PDF } });
  const moved = blobs.externalize(db);
  const receipt = read(moved, 'hr.expense', id).receipt;
  assert.equal(receipt.data, undefined);
  assert.match(receipt.blob, /^[0-9a-f]{32}$/);
  assert.equal(Buffer.from(blobs.get(receipt.blob).data).toString(), '%PDF-1.4 receipt');
  assert.equal(blobs.externalize(moved), moved);
  assert.ok(JSON.stringify(moved).length < JSON.stringify(db).length);
  assert.equal(blobs.get('../etc'), undefined);
});

test('stored files validate as references and only raster images reach the website', () => {
  const ref = { name: 'p.png', type: 'image/png', size: 8, blob: 'ab'.repeat(16) };
  assert.deepEqual(cleanValue({ type: 'binary' }, ref, 'image'), ref);
  assert.throws(() => cleanValue({ type: 'binary' }, { blob: '../x' }, 'image'));
  assert.equal(safeImage(ref), `/api/public/image/${ref.blob}`);
  assert.equal(safeImage({ ...ref, type: 'text/html' }), null);
  assert.equal(safeImage({ data: PNG }), PNG);
});
