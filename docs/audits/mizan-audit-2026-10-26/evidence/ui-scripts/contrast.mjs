const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const L = (h) => { const [r, g, b] = hex(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const light = { brand: '#2f4fb5', 'brand-soft': '#e8edfb', bg: '#f6f7fb', surface: '#ffffff', border: '#e2e5ee', text: '#1f2430', muted: '#6b7280', danger: '#c0392b', success: '#1f9d55', warn: '#e3a008', white: '#ffffff' };
const dark = { brand: '#7b93f0', 'brand-soft': '#232b48', bg: '#12141a', surface: '#1b1e27', border: '#2d3241', text: '#e6e8ef', muted: '#9aa1b3', danger: '#f0786a', success: '#4cc488', warn: '#f2c14e', white: '#ffffff', 'btn-primary': '#4a63d8' };
const pairs = [['text', 'surface'], ['text', 'bg'], ['muted', 'surface'], ['muted', 'bg'], ['brand', 'surface'], ['brand', 'bg'], ['brand', 'brand-soft'], ['white', 'brand'], ['danger', 'surface'], ['success', 'surface'], ['warn', 'surface'], ['border', 'surface']];
for (const [name, T] of [['light', light], ['dark', dark]]) {
  console.log(`-- ${name}`);
  for (const [f, b] of [...pairs, ...(name === 'dark' ? [['white', 'btn-primary']] : [])]) {
    const r = ratio(T[f], T[b]);
    const need = f === 'border' ? 3 : 4.5;
    console.log(`${(f + ' on ' + b).padEnd(24)} ${r.toFixed(2)}:1 ${r >= need ? 'pass' : `FAIL (<${need})`}`);
  }
}
