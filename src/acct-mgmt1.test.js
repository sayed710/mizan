import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const name of ['UnrealizedCurrencies', 'LoansAnalysis', 'CashflowAnalysis']) {
  test(`${name} offers company-aware printable exports`, () => {
    const source = readFileSync(new URL(`./views/${name}.jsx`, import.meta.url), 'utf8');
    for (const feature of ['CompanySelect', 'downloadCsv', 'downloadXlsx', 'ReportPrintView']) assert.ok(source.includes(feature), feature);
    if (name === 'LoansAnalysis') assert.match(source, /<tfoot>/);
  });
}

