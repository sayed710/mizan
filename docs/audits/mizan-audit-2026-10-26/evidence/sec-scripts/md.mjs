await import(process.argv[2] + "/src/models/index.js");
const { renderMarkdown } = await import(process.argv[2] + '/src/models/blog.js');
for (const p of ['<img src=x onerror=alert(1)>', '[a](javascript:alert(1))', '[a](https://x"onmouseover="alert(1))', '[**a**](https://x)*b*', '[x](https://a/\u00000\u0000)', '\u00000\u0000[q](http://e/"><svg/onload=alert(1)>)', '[a](HTTPS://x/&quot;onclick=alert(1)//)']) console.log(JSON.stringify(p), '=>', renderMarkdown(p));
