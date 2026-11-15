import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATTERN_KEYS, translatePattern } from './i18n-patterns.js';

// Arabic must be active before i18n.js reads the language at import time.
globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
const { t } = await import('./i18n.js');

const noLookup = () => undefined;
const ARABIC = /[؀-ۿ]/;

test('a message carrying a value is translated around that value', () => {
  assert.equal(translatePattern('Journal Bank EGP belongs to another company', noLookup), 'دفتر اليومية Bank EGP يتبع شركة أخرى');
});

test('values keep their order when the Arabic sentence reorders them', () => {
  assert.equal(translatePattern('Only 3 Desk in stock', noLookup), 'المتوفر في المخزون 3 فقط من Desk');
});

test('a value that is itself a known label is translated', () => {
  const lookup = (value) => (value === 'Partner' ? 'الشريك' : undefined);
  assert.equal(translatePattern('Invalid value for Partner', lookup), 'قيمة غير صالحة للحقل الشريك');
});

test('the more specific message wins over a general one', () => {
  assert.equal(
    translatePattern('Configure the expense account on asset Laptop', noLookup),
    'حدّد حساب المصروف على الأصل Laptop',
  );
});

test('a word the code puts inside a message is translated with it', () => {
  assert.equal(translatePattern('Configure the disposal loss account on company Mizan', noLookup), 'حدّد حساب خسارة الاستبعاد على الشركة Mizan');
});

test('a lower-case value finds the label written with a capital', () => {
  const lookup = (value) => (value === 'Confirm' ? 'تأكيد' : undefined);
  assert.equal(translatePattern('Cannot confirm this budget in its current state', lookup), 'لا يمكن تنفيذ الإجراء (تأكيد) على هذه الموازنة في حالتها الحالية');
});

test('a value that is a smaller message is translated too', () => {
  assert.equal(translatePattern('Configure the debit account on salary rule Basic', noLookup), 'حدّد حساب المدين على قاعدة الراتب Basic');
});

test('a value named like a built-in object member stays as written', () => {
  assert.equal(translatePattern('Currency constructor not found', noLookup), 'العملة constructor غير موجودة');
});

test('a message spanning lines keeps its line breaks', () => {
  assert.equal(translatePattern('Refuse reason:\nToo late', noLookup), 'سبب الرفض:\nToo late');
});

test('a message no pattern covers is left alone', () => {
  assert.equal(translatePattern('Nothing like this exists anywhere', noLookup), null);
});

test('t() falls back to patterns in Arabic and still prefers an exact entry', () => {
  assert.equal(t('Transfer WH/OUT/7 not found'), 'التحويل WH/OUT/7 غير موجود');
  assert.match(t('Save'), ARABIC);
  assert.equal(t('constructor'), 'constructor');
});

test('every pattern keeps exactly the values of its English message', () => {
  for (const key of PATTERN_KEYS) {
    const sample = key.replace(/\{(\d+)\}/g, 'v$1');
    const arabic = translatePattern(sample, noLookup);
    assert.match(arabic ?? '', ARABIC, key);
    for (const [, n] of key.matchAll(/\{(\d+)\}/g)) assert.ok(arabic.includes(`v${n}`), `${key} loses value ${n}`);
    assert.doesNotMatch(arabic, /\{\d+\}/, key);
  }
});

test('a message whose last value is empty is still translated', () => {
  assert.equal(t('No value for {{1}}'), 'لا توجد قيمة للمتغير {{1}}');
  assert.equal(t('No value for {{2}} (partner.name)'), 'لا توجد قيمة للمتغير {{2}} (partner.name)');
});

test('messages nested inside a value stop being translated after a few levels', () => {
  const deep = `${'Journal '.repeat(5000)}X${' belongs to another company'.repeat(5000)}`;
  const arabic = t(deep);
  assert.ok(arabic.startsWith('دفتر اليومية دفتر اليومية دفتر اليومية Journal '));
});

test('browser dialogs show their message in Arabic and pass other arguments through', async () => {
  const { translateDialogs } = await import('./i18n.js');
  const shown = [];
  const page = { alert: (m) => shown.push(m), confirm: (m) => shown.push(m) > 0, prompt: (m, initial) => { shown.push(m); return initial; } };
  translateDialogs(page);
  page.alert('Failed: 1/3 correct, try again');
  assert.equal(page.confirm('Less than the bill of materials is consumed for Desk. Produce anyway?'), true);
  assert.equal(page.prompt('Type your full name to sign (signer: Mona)', 'M'), 'M');
  assert.deepEqual(shown, [
    'لم تنجح: 1/3 إجابة صحيحة، حاول مرة أخرى',
    'المستهلَك من Desk أقل من قائمة المواد. هل تريد الإنتاج على أي حال؟',
    'اكتب اسمك الكامل للتوقيع (الموقّع: Mona)',
  ]);
});

// Messages built purely from values and punctuation, with no words of their own to translate.
const VALUE_ONLY = /^(?:\{\d+\}|[\s:.,()#"·→-])*$/;

/** Template-literal messages in the app and the server, written like the pattern keys: `Journal {1} belongs…`. */
function sourceTemplates() {
  // The server's database lease and backup tool speak to an operator at a terminal, not to a screen.
  const skipped = ['seed.js', 'migrations.js', 'i18n.js', 'i18n-patterns.js', 'storage.js', 'backup.js'];
  const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) return n === 'test-support' ? [] : walk(p);
    return /\.jsx?$/.test(n) && !n.includes('.test.') && !skipped.includes(n) ? [p] : [];
  });
  const files = ['.', '../server'].flatMap((folder) => walk(fileURLToPath(new URL(folder, import.meta.url))));
  const ESCAPES = { n: '\n', t: '\t' };
  const found = new Map();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const start of source.matchAll(/(?:\b(?:new Error|alert|confirm|prompt)\(|\berror:)\s*`/g)) {
      let i = start.index + start[0].length;
      let text = '';
      let values = 0;
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') { text += ESCAPES[source[i + 1]] ?? source[i + 1]; i += 2; continue; }
        if (source[i] === '$' && source[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < source.length && depth) { if (source[i] === '{') depth += 1; else if (source[i] === '}') depth -= 1; i += 1; }
          values += 1;
          text += `{${values}}`;
          continue;
        }
        text += source[i];
        i += 1;
      }
      if (values) found.set(text, file);
    }
  }
  return found;
}

test('every message built with values has an Arabic pattern', () => {
  const known = new Set(PATTERN_KEYS);
  const missing = [...sourceTemplates()]
    .filter(([text]) => !known.has(text) && !VALUE_ONLY.test(text))
    .map(([text, file]) => `${JSON.stringify(text)}  (${file})`);
  assert.deepEqual(missing, []);
});
