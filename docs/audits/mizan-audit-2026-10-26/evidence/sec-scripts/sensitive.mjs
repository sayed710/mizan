const { models } = await import(process.argv[2] + '/src/models/index.js');
const rx = /token|secret|password|passwd|api_key|apikey|pin$|^pin|hash|iban|bank_account|identification|passport|private_|wage|salary|ssn/i;
const out = [];
for (const [m, def] of Object.entries(models)) for (const [k, f] of Object.entries(def.fields)) if (rx.test(k)) out.push(`${m}.${k}(${f.type}${f.readonly?',ro':''})`);
console.log(out.join(' '));
