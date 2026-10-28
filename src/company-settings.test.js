import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './orm.js';
import { renameCompany } from './models/company.js';
import { seed } from './seed.js';

test('renaming the company in settings renames the company record that documents and the navbar read', () => {
  const db = seed();
  const renamed = renameCompany(db, 1, 'Renamed Trading LLC');
  assert.equal(read(renamed, 'res.company', 1).name, 'Renamed Trading LLC');
  assert.equal(renamed.settings.company, 'Renamed Trading LLC');
  assert.throws(() => renameCompany(db, 1, ''), /required/);
});
