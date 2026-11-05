import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { importCurl, parseCurl, quickRequest, tokenize, toCurl } from '../../src/curl';
import { parseRequest } from '../../src/httpFile';

test('tokenize: kutip tunggal, ganda (escape), $\'…\' ANSI-C, backslash, sambungan baris', () => {
  assert.deepEqual(tokenize(`curl 'a b' "c \\"d\\" \\$e" $'x\\ny\\'z\\x41' f\\ g \\\n  -k`), ['curl', 'a b', 'c "d" $e', "x\ny'zA", 'f g', '-k']);
  assert.deepEqual(tokenize(`curl -H 'it'"'"'s'`), ['curl', '-H', "it's"]);
  assert.throws(() => tokenize(`curl 'open`), /Unclosed quote/);
});

test('parseCurl: method, URL, header, body; -d tanpa -X = POST form', () => {
  const r = parseCurl(`curl 'https://api.test/log?x=1' -H 'Content-Type: application/json' -H 'X-Id: 7' --data-raw '{"a":1}'`);
  assert.deepEqual([r.request.method, r.request.url, r.request.body, r.request.bodyType], ['POST', 'https://api.test/log?x=1', '{"a":1}', 'json']);
  assert.deepEqual(r.request.headers.map((h) => `${h.name}: ${h.value}`), ['Content-Type: application/json', 'X-Id: 7']);
  assert.deepEqual(r.warnings, []);
  const form = parseCurl(`curl -d a=1 -d b=2 https://a.test`);
  assert.deepEqual([form.request.method, form.request.body], ['POST', 'a=1&b=2']);
  assert.ok(form.request.headers.some((h) => h.name === 'Content-Type' && h.value === 'application/x-www-form-urlencoded'));
  assert.equal(parseCurl(`curl -X PUT --url https://a.test/1 --data-binary @file`).request.method, 'PUT');
});

test('parseCurl: -u, -b, -L, -k, -G, -I, --json, -A, -e, --data-urlencode', () => {
  const r = parseCurl(`curl -u user:pa:ss -b 'sid=1; t=2' -k -A 'agent/1' -e https://ref.test https://a.test`);
  assert.ok(r.request.headers.some((h) => h.name === 'Authorization' && h.value === 'Basic user:pa:ss'));
  assert.ok(r.request.headers.some((h) => h.name === 'Cookie' && h.value === 'sid=1; t=2'));
  assert.ok(r.request.headers.some((h) => h.name === 'User-Agent' && h.value === 'agent/1'));
  assert.ok(r.request.headers.some((h) => h.name === 'Referer' && h.value === 'https://ref.test'));
  assert.equal(r.request.insecure, true);
  assert.equal(r.request.followRedirects, false, 'tanpa -L curl tidak mengikuti redirect');
  assert.equal(parseCurl('curl -L https://a').request.followRedirects, true);
  const g = parseCurl(`curl -G -d q=a -d page=2 https://a.test/s`);
  assert.deepEqual([g.request.method, g.request.url, g.request.body], ['GET', 'https://a.test/s?q=a&page=2', '']);
  assert.equal(parseCurl('curl -I https://a').request.method, 'HEAD');
  const j = parseCurl(`curl --json '{"x":1}' https://a`);
  assert.deepEqual([j.request.method, j.request.body, j.request.bodyType], ['POST', '{"x":1}', 'json']);
  assert.equal(parseCurl(`curl --data-urlencode 'q=a b&c' https://a`).request.body, 'q=a%20b%26c');
});

test('parseCurl: opsi tak dikenal & yang tidak diimpor dilaporkan; bukan perintah curl = error', () => {
  const r = parseCurl(`curl --compressed -s --http2 --weird https://a`);
  assert.deepEqual(r.warnings, ['Ignored option --http2', 'Unknown option --weird']);
  assert.throws(() => parseCurl('wget https://a'), /Not a curl command/);
  assert.throws(() => parseCurl('curl -H x'), /No URL/);
});

test('toCurl: perintah bash multi-baris dengan kutip aman; dibaca balik sama', () => {
  const req = parseRequest(`POST https://api.test/x?y=1\nContent-Type: application/json\n# @disabled X-Off: 1\n\n{"it's":1}\n`);
  req.insecure = true;
  const cmd = toCurl(req);
  assert.equal(cmd, `curl -X POST 'https://api.test/x?y=1' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{"it'\\''s":1}' \\\n  -L \\\n  -k`);
  const back = parseCurl(cmd).request;
  assert.deepEqual([back.method, back.url, back.body, back.insecure, back.followRedirects], ['POST', 'https://api.test/x?y=1', `{"it's":1}`, true, true]);
  assert.equal(toCurl(parseRequest('GET https://a\n')), `curl 'https://a' \\\n  -L`);
});

// contoh "Copy as cURL (bash)" Chrome, data disamarkan
const CHROME = `curl 'https://shop.example.com/pos/log/post' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'accept-language: en-US,en;q=0.9,id;q=0.8' \\
  -H 'authorization: Bearer eyJhbGciOi.REDACTED.sig' \\
  -H 'content-type: application/json' \\
  -b 'JSESSIONID=ABC123; theme=dark' \\
  -H 'origin: https://shop.example.com' \\
  -H 'priority: u=1, i' \\
  -H 'referer: https://shop.example.com/dashboard' \\
  -H 'sec-ch-ua: "Chromium";v="142", "Not_A Brand";v="99"' \\
  -H 'sec-ch-ua-mobile: ?0' \\
  -H 'sec-ch-ua-platform: "Windows"' \\
  -H 'sec-fetch-dest: empty' \\
  -H 'sec-fetch-mode: cors' \\
  -H 'sec-fetch-site: same-origin' \\
  -H 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)' \\
  --data-raw '{"method":"Activity History","pathUrl":"dashboard"}'`;

test('importCurl: contoh Copy as cURL Chrome -> request lengkap, header browser dimatikan, ringkasan untuk notifikasi', () => {
  const { request, summary } = importCurl(CHROME);
  assert.deepEqual([request.method, request.url, request.bodyType], ['POST', 'https://shop.example.com/pos/log/post', 'json']);
  assert.equal(request.body, '{"method":"Activity History","pathUrl":"dashboard"}');
  const on = request.headers.filter((h) => h.enabled).map((h) => h.name.toLowerCase());
  const off = request.headers.filter((h) => !h.enabled).map((h) => h.name.toLowerCase());
  assert.deepEqual(on, ['accept', 'authorization', 'content-type', 'cookie']);
  assert.deepEqual(off.sort(), ['accept-language', 'origin', 'priority', 'referer', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'user-agent']);
  assert.equal(summary, 'Imported POST /pos/log/post: 11 browser headers disabled.');
  assert.equal(request.followRedirects, true, 'Copy as cURL browser tidak pernah memakai -L, padahal browser mengikuti redirect');
  assert.equal(importCurl(`curl --http2 https://a/x`).summary, 'Imported GET /x. Ignored option --http2');
});

test('toCurl: header Cookie tidak ikut kecuali dicentang (withCookies); cookie jar digabung; importCookies dari Cookie: / -b', () => {
  const req = parseRequest('GET https://a.test/x\nCookie: sid=1\nX-A: 1\n');
  assert.equal(toCurl(req), `curl 'https://a.test/x' \\\n  -H 'X-A: 1' \\\n  -L`);
  assert.equal(toCurl(req, { withCookies: true, jar: 'theme=dark; sid=9' }), `curl 'https://a.test/x' \\\n  -H 'X-A: 1' \\\n  -b 'sid=1; theme=dark' \\\n  -L`);
  assert.equal(toCurl(parseRequest('GET https://a\n'), { withCookies: true, jar: 'k=v' }), `curl 'https://a' \\\n  -b 'k=v' \\\n  -L`);
  assert.equal(importCurl(`curl https://a -b 'sid=1; t=2'`).cookies, 'sid=1; t=2');
  assert.equal(importCurl(`curl https://a -H 'Cookie: a=b'`).cookies, 'a=b');
  assert.equal(importCurl(`curl https://a`).cookies, undefined);
});

test('quickRequest: URL polos = GET, "METHOD URL", curl, tanpa skema ditolak', () => {
  const u = quickRequest('  https://auth.dev.karedoc.net  ');
  assert.equal(u.method, 'GET');
  assert.equal(u.url, 'https://auth.dev.karedoc.net');
  const m = quickRequest('post http://a.test/x');
  assert.equal(m.method, 'POST');
  assert.equal(m.url, 'http://a.test/x');
  assert.equal(quickRequest(`curl -X PUT https://a.test -d 'x=1'`).method, 'PUT');
  assert.equal(quickRequest('https://a.test/{{path}}').url, 'https://a.test/{{path}}');
  assert.throws(() => quickRequest('auth.dev.karedoc.net'), /curl command or a URL/);
  assert.throws(() => quickRequest('   '), /curl command or a URL/);
});

// --- Fase 5: dialek cmd / PowerShell, -F, Copy as cURL (cmd / PowerShell), header browser ---
import { tokenizeCmd, tokenizePs, toCurlCmd, toPowerShell, isPowerShellRequest } from '../../src/shellDialect';
import type { ParsedRequest } from '../../src/httpFile';

test('tokenizeCmd: ^ = escape, ^ di akhir baris = sambung, \\" = kutip literal di dalam "…"', () => {
  assert.deepEqual(tokenizeCmd('curl https://a.test/x?a=1^&b=2 ^\r\n  -H "accept: */*" ^\n  --data-raw ^"^{^\\^"a^\\^":^\\^"b c^\\^"^}^"'),
    ['curl', 'https://a.test/x?a=1&b=2', '-H', 'accept: */*', '--data-raw', '{"a":"b c"}']);
  assert.deepEqual(tokenizeCmd('curl ^"https://a.test/^%25^" -d ^"x^^y^"'), ['curl', 'https://a.test/%25', '-d', 'x^y']);
  assert.throws(() => tokenizeCmd('curl "open'), /Unclosed quote/);
});

test('tokenizePs: backtick = escape / sambung, \'…\' literal (\'\' = kutip), "…" dengan `" `` `n `$ dan ""', () => {
  assert.deepEqual(tokenizePs("curl.exe 'https://a.test/x' `\n  -H 'it''s: ok' `\r\n  --data-raw \"{`\"a`\":`\"b`n`$x\"\"}\""),
    ['curl.exe', 'https://a.test/x', '-H', "it's: ok", '--data-raw', '{"a":"b\n$x"}']);
  assert.throws(() => tokenizePs("curl 'open"), /Unclosed quote/);
});

const CHROME_BASH = `curl 'https://api.example.com/v1/items?x=1' \\
  -H 'accept: application/json' \\
  -H 'content-type: application/json' \\
  -H 'cookie: sid=abc' \\
  -H 'sec-ch-ua: "Chromium";v="120"' \\
  -H 'user-agent: Mozilla/5.0 Test' \\
  --data-raw '{"name":"a b","q":"it'\\''s"}' \\
  --compressed`;
const CHROME_CMD = `curl "https://api.example.com/v1/items?x=1" ^
  -H "accept: application/json" ^
  -H "content-type: application/json" ^
  -H "cookie: sid=abc" ^
  -H ^"sec-ch-ua: ^\\^"Chromium^\\^";v=^\\^"120^\\^"^" ^
  -H "user-agent: Mozilla/5.0 Test" ^
  --data-raw ^"^{^\\^"name^\\^":^\\^"a b^\\^",^\\^"q^\\^":^\\^"it's^\\^"^}^" ^
  --compressed`;
const CHROME_PS = `$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$session.UserAgent = "Mozilla/5.0 Test"
$session.Cookies.Add((New-Object System.Net.Cookie("sid", "abc", "/", "api.example.com")))
Invoke-WebRequest -UseBasicParsing -Uri "https://api.example.com/v1/items?x=1" \`
-Method "POST" \`
-WebSession $session \`
-Headers @{
"accept"="application/json"
  "sec-ch-ua"="\`"Chromium\`";v=\`"120\`""
} \`
-ContentType "application/json" \`
-Body "{\`"name\`":\`"a b\`",\`"q\`":\`"it's\`"}"`;

const canon = (r: ParsedRequest) => ({
  method: r.method, url: r.url, body: r.body, follow: r.followRedirects,
  headers: r.headers.map((h) => `${h.name.toLowerCase()}: ${h.value} ${h.enabled ? 'on' : 'off'}`).sort(),
});

test('fixture "Copy as cURL" bash, cmd, dan PowerShell menghasilkan request yang sama persis (header browser nonaktif)', () => {
  const bash = importCurl(CHROME_BASH).request;
  assert.equal(bash.method, 'POST');
  assert.equal(bash.body, `{"name":"a b","q":"it's"}`);
  assert.deepEqual(bash.headers.filter((h) => !h.enabled).map((h) => h.name).sort(), ['sec-ch-ua', 'user-agent']);
  assert.deepEqual(canon(importCurl(CHROME_CMD).request), canon(bash));
  assert.deepEqual(canon(importCurl(CHROME_PS).request), canon(bash));
});

test('import PowerShell: -Uri/-Method/-Headers/-ContentType/-Body, $session UA & cookie, Invoke-RestMethod, opsi lain', () => {
  const r = parseCurl(`Invoke-RestMethod -Uri 'https://a.test/x' -Method Put -Headers @{ 'X-A' = '1'; "X-B"="two words" } -Body 'k=v' -ContentType 'text/plain' -MaximumRedirection 0 -SkipCertificateCheck -TimeoutSec 7`);
  assert.equal(r.request.method, 'PUT');
  assert.deepEqual(r.request.headers.map((h) => [h.name, h.value]), [['X-A', '1'], ['X-B', 'two words'], ['Content-Type', 'text/plain']]);
  assert.equal(r.request.body, 'k=v');
  assert.equal(r.request.followRedirects, false);
  assert.equal(r.request.insecure, true);
  assert.equal(r.request.timeoutSec, 7);
  assert.equal(parseCurl(`iwr https://a.test/`).request.url, 'https://a.test/');
  assert.equal(parseCurl(`Invoke-WebRequest -Uri https://a.test/ -Body 'x'`).request.method, 'POST');
  assert.ok(parseCurl(`Invoke-WebRequest -Uri https://a.test/ -OutFile x.bin`).warnings.some((w) => /OutFile/.test(w)));
  assert.throws(() => parseCurl(`Invoke-WebRequest -Method Get`), /No URL/);
  assert.equal(isPowerShellRequest('Invoke-WebRequest -Uri x'), true);
  assert.equal(isPowerShellRequest('curl https://x'), false);
});

test('-F / --form: field, file (< ./path), type, Content-Type multipart + boundary; --data-urlencode', () => {
  const r = parseCurl(`curl https://a.test/up -F 'title=My Doc' -F 'file=@./pics/a.png;type=image/png' -F 'note=<./n.txt'`).request;
  assert.equal(r.method, 'POST');
  const ct = r.headers.find((h) => h.name === 'Content-Type')!.value;
  const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(ct)![1];
  assert.equal(r.body, [
    `--${boundary}`, 'Content-Disposition: form-data; name="title"', '', 'My Doc',
    `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="a.png"', 'Content-Type: image/png', '', '< ./pics/a.png',
    `--${boundary}`, 'Content-Disposition: form-data; name="note"', '', '< ./n.txt',
    `--${boundary}--`,
  ].join('\n'));
  assert.equal(parseCurl(`curl https://a.test -F 'f=@C:\\tmp\\x.bin'`).request.body.includes('filename="x.bin"'), true);
  assert.equal(parseCurl(`curl https://a.test --data-urlencode 'q=a b&c' --data-urlencode 'r@x'`).request.body, 'q=a%20b%26c&r%40x');
});

test('toCurlCmd / toPowerShell: round-trip (export -> import = request sama)', () => {
  const req = parseRequest(`POST https://a.test/p?x=1&y=2\nContent-Type: application/json\nX-Q: say "hi" it's 100%\n\n{"a":"b \\"c\\"","d":"it's"}\n`);
  const cmd = toCurlCmd(req);
  assert.ok(/\^$/m.test(cmd), 'baris disambung dengan ^');
  assert.deepEqual(canon(importCurl(cmd).request), canon(importCurl(toCurl(req)).request));
  const ps = toPowerShell(req);
  assert.match(ps, /^Invoke-WebRequest -UseBasicParsing -Uri /);
  assert.deepEqual(canon(importCurl(ps).request), canon(importCurl(toCurl(req)).request));
  // body file & cookie: sama seperti toCurl
  assert.match(toPowerShell(parseRequest('GET https://a.test\nCookie: s=1\n'), { withCookies: true }), /\$session\.Cookies\.Add/);
  assert.doesNotMatch(toPowerShell(parseRequest('GET https://a.test\nCookie: s=1\n')), /Cookie/);
});

test('header browser: Connection ikut nonaktif; --aws-sigv4 jadi # @auth aws', () => {
  const r = importCurl(`curl https://a.test -H 'Connection: keep-alive' -H 'Accept-Encoding: gzip' -H 'X-Keep: 1'`).request;
  assert.deepEqual(r.headers.map((h) => [h.name, h.enabled]), [['Connection', false], ['Accept-Encoding', false], ['X-Keep', true]]);
  const a = parseCurl(`curl https://s3.us-east-1.amazonaws.com/b --aws-sigv4 'aws:amz:us-east-1:s3' --user 'AKID:SECRET'`).request;
  assert.equal(a.auth, 'aws access_key="AKID" secret_key="SECRET" region="us-east-1" service="s3"');
  assert.deepEqual(a.headers, []);
});

test('Copy as cURL: Basic / Digest / AWS pakai opsi cURL asli (-u, --digest, --aws-sigv4) dan round-trip ke request yang sama', () => {
  const basic = parseRequest('GET https://a.test/x\nAuthorization: Basic us:pa:ss\n');
  assert.equal(toCurl(basic), `curl 'https://a.test/x' \\\n  -u 'us:pa:ss' \\\n  -L`);
  assert.equal(toCurl(basic, { longForm: true, multiLine: false }), `curl 'https://a.test/x' --user 'us:pa:ss' --location`);
  assert.match(toCurl(parseRequest('GET https://a.test/x\n# @auth basic username="u" password="p w"\n')), /-u 'u:p w'/);
  assert.match(toCurl(parseRequest('GET https://a.test/x\n# @auth digest username="u" password="p"\n')), /--digest \\\n  -u 'u:p'/);
  const aws = parseRequest('GET https://s3.us-east-1.amazonaws.com/b\n# @auth aws access_key="AK" secret_key="SK" region="us-east-1" service="s3"\n');
  assert.match(toCurl(aws), /--aws-sigv4 'aws:amz:us-east-1:s3' \\\n  --user 'AK:SK'/);
  assert.equal(importCurl(toCurl(aws)).request.auth, 'aws access_key="AK" secret_key="SK" region="us-east-1" service="s3"');
  assert.deepEqual(importCurl(toCurl(basic)).request.headers.map((h) => [h.name, h.value]), [['Authorization', 'Basic us:pa:ss']]);
  assert.match(toCurlCmd(basic), /-u \^"us:pa:ss\^"/);
  // PowerShell: header Basic harus base64 sungguhan (bentuk mentah tidak valid di HTTP)
  assert.match(toPowerShell(basic), new RegExp(`"Authorization"="Basic ${Buffer.from('us:pa:ss').toString('base64')}"`));
  // Bearer & lainnya: tetap header; {{var}} di Basic tidak bisa di-encode -> header apa adanya
  assert.match(toCurl(parseRequest('GET https://a.test\nAuthorization: Bearer t\n')), /-H 'Authorization: Bearer t'/);
  assert.match(toPowerShell(parseRequest('GET https://a.test\nAuthorization: Basic {{u}}:{{p}}\n')), /Basic \{\{u\}\}:\{\{p\}\}/);
});

test('import --digest -u user:pass -> Authorization: Digest user pass (dihitung saat Send)', () => {
  const r = parseCurl(`curl --digest -u 'us:pa ss' https://a.test/x`).request;
  assert.deepEqual(r.headers.map((h) => [h.name, h.value]), [['Authorization', 'Digest us pa ss']]);
  assert.deepEqual(importCurl(toCurl(parseRequest('GET https://a.test/x\n# @auth digest username="u" password="p"\n'))).request.headers.map((h) => h.value), ['Digest u p']);
});
