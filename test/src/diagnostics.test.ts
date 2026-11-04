import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  completionNames, diagnoseEnvironmentJson, diagnoseHttp, fileVariables, findKeyInJson, findReferences, findVarTokens, hoverInfo, hoverMarkdown,
  missingVariables, positionAt, varStatus, type VarContext,
} from '../../src/diagnostics';

const ctx: VarContext = {
  active: 'uat',
  environments: [
    { name: 'dev', values: new Map([['baseUrl', 'http://dev'], ['apiKey', 'dev-key'], ['token', 'dev-secret']]), secret: new Set(['token']) },
    { name: 'prod', values: new Map([['baseUrl', 'https://prod'], ['apiKey', null], ['token', null]]), secret: new Set(['token']) },
    { name: 'uat', values: new Map([['baseUrl', 'https://uat'], ['apiKey', null], ['token', 's3cret'], ['g', null]]), secret: new Set(['token']) },
  ],
  globals: new Map([['g', 'from-globals'], ['gn', null]]),
};

test('findVarTokens: {{name}}, {{ spasi }}, {{$dynamic arg}}, script httpme.environment.get/set; posisi & urutan', () => {
  const text = 'GET {{baseUrl}}/x?a={{ apiKey }}&t={{$randomInt 1 9}}';
  assert.deepEqual(findVarTokens(text), [
    { name: 'baseUrl', start: 4, end: 15, kind: 'var' },
    { name: 'apiKey', start: 20, end: 32, kind: 'var' },
    { name: '$randomInt', args: '1 9', start: 35, end: 53, kind: 'dynamic' },
  ]);
  const js = `const t = httpme.environment.get('token');\nhttpme.environment.set("next", t); // {{baseUrl}}`;
  assert.deepEqual(findVarTokens(js, true).map((t) => [t.name, t.kind, js.slice(t.start, t.end)]), [
    ['token', 'script', 'token'], ['next', 'script', 'next'], ['baseUrl', 'var', '{{baseUrl}}'],
  ]);
  assert.deepEqual(findVarTokens('{{}} {{ }} {x}'), []);
});

test('varStatus & pesan: NULL di Environment aktif (+ daftar lain), tidak ada, Globals menutup NULL, variabel file, dinamis', () => {
  const file = fileVariables('@host = a\nGET {{host}}');
  assert.deepEqual(file, new Map([['host', 'a']]));
  assert.deepEqual(varStatus('apiKey', ctx), { kind: 'null', message: 'apiKey is NULL in Environment "uat" (also NULL in: prod)' });
  assert.deepEqual(varStatus('clientSecret', ctx), { kind: 'missing', message: 'Variable "clientSecret" not found' });
  assert.deepEqual(varStatus('g', ctx), { kind: 'ok' }, 'NULL di uat tapi ada di Globals');
  assert.deepEqual(varStatus('gn', ctx), { kind: 'null', message: 'gn is NULL in Globals' });
  assert.deepEqual(varStatus('host', ctx, file), { kind: 'ok' });
  assert.deepEqual(varStatus('$guid', ctx), { kind: 'dynamic' });
  assert.deepEqual(varStatus('$nope', ctx), { kind: 'missing', message: 'Unknown dynamic variable "$nope"' });
  assert.deepEqual(varStatus('baseUrl', { ...ctx, active: undefined }), { kind: 'missing', message: 'Variable "baseUrl" needs an active Environment (defined in: dev, prod, uat)' });
  assert.deepEqual(varStatus('x', { ...ctx, script: new Set(['x']) }), { kind: 'ok' });
});

test('diagnoseHttp: range baris/kolom + pesan, hanya yang bermasalah', () => {
  const text = '@ok = 1\nGET {{baseUrl}}/a\nX-Key: {{apiKey}}\nX-Other: {{clientSecret}} {{$nope}} {{ok}}\n';
  const d = diagnoseHttp(text, ctx);
  assert.deepEqual(d.map((x) => [x.name, x.range.start.line, x.range.start.character, x.range.end.character, x.kind]), [
    ['apiKey', 2, 7, 17, 'null'], ['clientSecret', 3, 9, 25, 'missing'], ['$nope', 3, 26, 35, 'missing'],
  ]);
  assert.equal(d[0].message, 'apiKey is NULL in Environment "uat" (also NULL in: prod)');
  assert.deepEqual(positionAt('a\r\nbc\nd', 5), { line: 1, character: 2 });
  assert.deepEqual(missingVariables(text, ctx), ['clientSecret', '$nope']);
});

const ENV = `{
  "httpmeFormat": 1,
  "variables": [
    { "key": "baseUrl", "value": "https://prod" },
    {
      "key": "apiKey",
      "value": null
    },
    { "key": "token", "secret": true }
  ]
}
`;

test('diagnoseEnvironmentJson: "value": null diberi pesan per key; findKeyInJson menemukan nama key', () => {
  const d = diagnoseEnvironmentJson(ENV, 'prod');
  assert.deepEqual(d.map((x) => [x.message, x.range.start.line, x.range.start.character, x.range.end.character]), [['apiKey has no value (NULL) in Environment "prod"', 6, 15, 19]]);
  const at = findKeyInJson(ENV, 'apiKey')!;
  assert.equal(ENV.slice(at.start, at.end), 'apiKey');
  assert.equal(positionAt(ENV, at.start).line, 5);
  assert.equal(findKeyInJson(ENV, 'nope'), undefined);
  assert.equal(findKeyInJson('{"variables":[{"value":"apiKey","key":"a\\"b"}]}', 'a"b')!.start, 39);
});

test('hoverInfo / hoverMarkdown: nilai semua Environment (aktif ditandai), NULL, secret di-mask + Show, pesan, link Open', () => {
  const info = hoverInfo('token', ctx);
  assert.deepEqual(info.environments.map((e) => [e.name, e.value, e.secret, e.active]), [['dev', 'dev-secret', true, false], ['prod', null, true, false], ['uat', 's3cret', true, true]]);
  const md = hoverMarkdown(info);
  assert.ok(!md.includes('s3cret') && !md.includes('dev-secret'), 'secret tidak tampil');
  assert.match(md, /\*\*uat\*\* \(active\): `••••` \[Show\]\(command:httpme\.showSecret\?/);
  assert.match(md, /prod: _NULL_/);
  assert.match(md, /\[Open in Environment "uat"\]\(command:httpme\.gotoVariable\?%5B%22token%22%5D\)/);
  const nullMd = hoverMarkdown(hoverInfo('apiKey', ctx));
  assert.ok(nullMd.startsWith('$(error) apiKey is NULL in Environment "uat" (also NULL in: prod)'));
  assert.match(hoverMarkdown(hoverInfo('$guid', ctx)), /^Dynamic variable, generated at send time/);
  assert.match(hoverMarkdown(hoverInfo('g', ctx)), /Globals: `from-globals`/);
  assert.match(hoverMarkdown(hoverInfo('host', ctx, new Map([['host', 'a']]))), /File variable: `a`/);
  assert.match(hoverMarkdown(hoverInfo('s', { ...ctx, script: new Set(['s']) })), /Set by a script/);
});

test('findReferences: .http + script, hanya nama yang dicari', () => {
  const refs = findReferences([
    { path: 'a.http', text: 'GET {{baseUrl}}/x\n{{other}} {{ baseUrl }}' },
    { path: 'pre-request.js', text: "httpme.environment.set('baseUrl', 1)" },
  ], 'baseUrl');
  assert.deepEqual(refs.map((r) => [r.path, r.start, r.end]), [['a.http', 4, 15], ['a.http', 28, 41], ['pre-request.js', 24, 31]]);
});

test('completionNames: Environment aktif + Globals + variabel file + dinamis, unik & urut', () => {
  assert.deepEqual(completionNames(ctx, new Map([['host', 'a']])).slice(0, 6), ['apiKey', 'baseUrl', 'g', 'gn', 'host', 'token']);
  assert.ok(completionNames(ctx).includes('$uuid'));
});
