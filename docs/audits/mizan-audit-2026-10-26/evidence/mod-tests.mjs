// Map test blocks to models. Usage: node mod-tests.mjs <repo-copy> <outdir>
import fs from 'node:fs';
const root = process.argv[2]; const out = process.argv[3];
const { models } = await import(root + '/src/models/index.js');
const keys = Object.keys(models).sort((a, b) => b.length - a.length);
const files = [...fs.readdirSync(root + '/src').filter((f) => f.endsWith('.test.js')).map((f) => 'src/' + f),
  ...fs.readdirSync(root + '/server').filter((f) => f.endsWith('.test.js')).map((f) => 'server/' + f)];
const NEG = /assert\.(throws|rejects)\(|\.status, 4\d\d|, 4\d\d\)|assert\.(equal|deepEqual)\([^;]*(error|err)\b|\bnull\)|assert\.ok\(!|assert\.equal\([^;]*, false\)/;
const NEG_STRICT = /assert\.(throws|rejects)\(|status(Code)?, 4\d\d\b|\.status === 4\d\d|assert\.match\([^;]*(guard|refus|cannot|not allowed|only)/i;
const allBlocks = []; const perFile = []; const perModel = {}; const perModelNeg = {}; const perModelServer = {};
for (const f of files) {
  const src = fs.readFileSync(root + '/' + f, 'utf8');
  const blocks = src.split(/^(?=\s*test\()/m).filter((b) => /^\s*test\(/.test(b));
  let neg = 0;
  const header = src.split(/^(?=\s*test\()/m)[0];
  const consts = [...header.matchAll(/const (\w+) = ['"]([a-z_.]+)['"]/g)].filter((m) => models[m[2]]);
  for (const b0 of blocks) {
    let b = b0; for (const [, v, k] of consts) if (new RegExp('\\b' + v + '\\b').test(b0)) b += ` '${k}'`;
    const isNeg = NEG_STRICT.test(b0);
    if (isNeg) neg++;
    const viaServer = /applyDiff|fetch\(|request\(|\/api\//.test(b0);
    const found = new Set();
    for (const k of keys) if (b.includes(`'${k}'`) || b.includes(`"${k}"`) || b.includes('`' + k)) found.add(k);
    allBlocks.push({ file: f, title: (b0.match(/test\((['"`])(.*?)\1/) ?? [])[2] ?? '', models: [...found], neg: isNeg, server: viaServer, guardPath: /applyDiff\(|\.guard\(|protectDelete\(/.test(b0) });
    for (const k of found) { perModel[k] = (perModel[k] ?? 0) + 1; if (isNeg) perModelNeg[k] = (perModelNeg[k] ?? 0) + 1; if (viaServer) perModelServer[k] = (perModelServer[k] ?? 0) + 1; }
  }
  perFile.push({ file: f, tests: blocks.length, neg, grepCount: (src.match(/^\s*test\(/gm) ?? []).length });
}
fs.writeFileSync(out + '/tests.json', JSON.stringify({ allBlocks, perFile, perModel, perModelNeg, perModelServer }, null, 1));
console.log('files', perFile.length, 'tests', perFile.reduce((t, x) => t + x.tests, 0), 'neg', perFile.reduce((t, x) => t + x.neg, 0));
console.log('models never named in any test:', Object.keys(models).filter((k) => !perModel[k]).join(' '));
console.log('models never named in a negative test:', Object.keys(models).filter((k) => !perModelNeg[k]).length);
