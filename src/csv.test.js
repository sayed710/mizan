import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromCsv, toCsv } from './csv.js';
import { read, search } from './orm.js';
import { markDone } from './models/mail.js';
import { seed } from './seed.js';

test('csv round-trips quotes, commas, newlines and Arabic text', () => {
  const rows = [['Name', 'Note'], ['Nile "Furniture", Co.', 'line1\nline2'], ['شركة النيل', '']];
  assert.deepEqual(fromCsv('﻿' + toCsv(rows)), rows);
});

test('marking an activity done closes it and logs on the related record', () => {
  const db = seed();
  const act = search(db, 'mail.activity')[0];
  const next = markDone(db, act);
  assert.equal(read(next, 'mail.activity', act.id).done, true);
  const note = next.messages.at(-1);
  assert.equal(note.model, act.res_model);
  assert.equal(note.res_id, act.res_id);
  assert.match(note.body, /Call done: Discuss chair models/);
});
