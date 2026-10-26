const { models } = await import(process.argv[2] + '/src/models/index.js');
for (const [k, m] of Object.entries(models)) {
  const b = (m.form?.buttons ?? []).map((x) => x.label + (x.server ? '[S]' : '') + (x.vals && !x.run ? '[v]' : ''));
  if (b.length) console.log(k + ': ' + b.join(' | '));
}
