// Server lokal untuk test-extension/status-cards.http (httpbin.org sering ECONNRESET dan tidak punya body kosong / teks pendek)
// Jalankan: node test-extension/status-server.js [port]   (Ctrl+C untuk berhenti)
//   /status/<kode>  body kosong     /text/<kode>  teks satu baris    /json/<kode>  JSON
//   /multi/<kode>   teks multi-baris  /delay/<detik>  tunggu lalu 200
const http = require('node:http');
const port = Number(process.argv[2]) || 8099;
http.createServer((req, res) => {
  const [, kind, arg] = req.url.split('?')[0].split('/');
  const code = Number(arg);
  if (kind === 'delay') return void setTimeout(() => res.writeHead(200, { 'content-type': 'text/plain' }).end('done\n'), Number(arg) * 1000);
  if (!(code >= 200 && code <= 599)) return void res.writeHead(400, { 'content-type': 'text/plain' }).end('use /status|text|json|multi/<code> or /delay/<sec>');
  const head = (type) => res.writeHead(code, { 'content-type': type });
  if (kind === 'status') return void res.writeHead(code).end();
  if (kind === 'text') return void head('text/plain').end('Something went wrong on our side');
  if (kind === 'json') return void head('application/json').end(JSON.stringify({ error: 'example', code }));
  if (kind === 'multi') return void head('text/plain').end('line 1\nline 2\nline 3\n');
  res.writeHead(404).end();
}).listen(port, () => console.log(`status server on http://localhost:${port}`));
