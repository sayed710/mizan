const { apps, leavesOf } = await import(process.argv[2] + '/src/models/index.js');
for (const a of apps) {
  const leaves = leavesOf(a);
  console.log(a.id + ' | ' + a.name + ' | ' + leaves.map(l => l.model ? l.model + (l.view ? '['+l.view+']' : '') + (l.domain ? '*' : '') : 'TYPE:' + l.type).join(', '));
}
