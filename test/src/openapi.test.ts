import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importOpenApi, sampleFor } from '../../src/openapi';
import { parseDoc, type ImportPlan } from '../../src/importCommon';
import { parseRequest } from '../../src/httpFile';

const fx = (n: string) => readFileSync(join(__dirname, '../../../test/fixtures/import', n), 'utf8');
const p2 = (opts = {}) => importOpenApi(parseDoc(fx('petstore2.json')), opts);
const p3 = (opts = {}) => importOpenApi(parseDoc(fx('petstore3.yaml')), opts);
const get = (p: ImportPlan, path: string) => p.files.find((f) => f.path === path)!;
const req = (p: ImportPlan, path: string) => parseRequest(get(p, path).content);

test('Petstore 2.0: folder per tag, nama file dari operationId, tanpa tag = default', () => {
  const p = p2();
  assert.equal(p.name, 'Swagger Petstore');
  assert.deepEqual(p.files.map((f) => f.path).sort(), [
    'Swagger Petstore/_auth.http', 'Swagger Petstore/default/getInventory.http', 'Swagger Petstore/pet/addPet.http', 'Swagger Petstore/pet/getPetById.http',
    'Swagger Petstore/pet/updatePetWithForm.http', 'Swagger Petstore/pet/uploadFile.http',
  ]);
});

test('Petstore 2.0: judul ### = summary, @name + @operation = operationId, description komentar', () => {
  const r = req(p2(), 'Swagger Petstore/pet/addPet.http');
  assert.equal(r.title, 'Add a new pet');
  assert.equal(r.name, 'addPet');
  assert.equal(r.operation, 'addPet');
  assert.deepEqual(r.preamble, ['# Adds a pet.', '# Second line.']);
});

test('Petstore 2.0: base URL schemes+host+basePath -> variable <NAMA>_BASE_URL', () => {
  const p = p2();
  assert.deepEqual(p.environmentVars, [{ key: 'SWAGGER_PETSTORE_BASE_URL', value: 'https://petstore.swagger.io/v2' }]);
  const r = req(p, 'Swagger Petstore/pet/getPetById.http');
  assert.equal(r.method, 'GET');
  assert.equal(r.url, '{{SWAGGER_PETSTORE_BASE_URL}}/pet/0');
});

test('base URL cocok dengan nilai Environment -> pakai variable itu, tidak membuat baru', () => {
  const p = p2({ envs: [{ name: 'dev', values: new Map([['baseUrl', 'https://petstore.swagger.io/v2/'], ['petId', '9']]) }] });
  assert.equal(p.environmentVars, undefined);
  assert.equal(req(p, 'Swagger Petstore/pet/getPetById.http').url, '{{baseUrl}}/pet/{{petId}}', 'path param bernama sama dengan variable Environment');
});

test('parameter: wajib aktif, opsional # @disabled, nilai contoh (default / enum / example)', () => {
  const r = req(p2(), 'Swagger Petstore/pet/getPetById.http');
  assert.deepEqual(r.disabledParams, [{ key: 'verbose', value: 'true' }]);
  assert.deepEqual(r.headers.map((h) => [h.name, h.value, h.enabled]), [['X-Trace', 't1', true]]);
  const l = req(p3(), 'Petstore 3/pet/listPets.http');
  assert.equal(l.url, '{{PETSTORE_3_BASE_URL}}/pet?limit=10');
  assert.deepEqual(l.disabledParams, [{ key: 'cursor', value: 'abc' }]);
  assert.deepEqual(l.headers.map((h) => [h.name, h.value, h.enabled]), [['X-Trace', 't-1', false]], '$ref parameter di-resolve');
});

test('body 2.0: schema -> JSON contoh ($ref, readOnly dibuang, rekursi dibatasi)', () => {
  const r = req(p2(), 'Swagger Petstore/pet/addPet.http');
  assert.equal(r.headers.find((h) => h.name === 'Content-Type')?.value, 'application/json');
  const b = JSON.parse(r.body);
  assert.equal(b.name, 'doggie');
  assert.equal(b.id, undefined, 'readOnly');
  assert.deepEqual(b.category, { id: 0, name: 'string' });
  assert.deepEqual(b.tags, ['string']);
  assert.equal(b.status, 'available');
  assert.ok(b.parent === null || typeof b.parent === 'object', 'rekursi tidak meledak');
});

test('body 2.0: formData urlencoded & multipart (file -> < ./path)', () => {
  const f = req(p2(), 'Swagger Petstore/pet/updatePetWithForm.http');
  assert.equal(f.headers.find((h) => h.name === 'Content-Type')?.value, 'application/x-www-form-urlencoded');
  assert.equal(f.body, 'name=string&status=available');
  const m = get(p2(), 'Swagger Petstore/pet/uploadFile.http').content;
  assert.match(m, /Content-Type: multipart\/form-data; boundary=/);
  assert.match(m, /name="file"; filename="file"\n\n< \.\/file/);
});

test('body 3.x: json, xml, urlencoded, text/plain, tanpa schema', () => {
  const j = req(p3(), 'Petstore 3/pet/updatePet.http');
  const b = JSON.parse(j.body);
  assert.equal(b.name, 'doggie');
  assert.equal(b.born, '2024-01-01T00:00:00Z');
  assert.deepEqual(b.owner, { email: 'user@example.com', uid: '00000000-0000-0000-0000-000000000000', vip: true }, 'allOf digabung');
  assert.equal(b.kind, 'dog', 'oneOf pilihan pertama');
  const form = req(p3(), 'Petstore 3/auth/login.http');
  assert.equal(form.body, 'user=bob&pw=string');
  const note = req(p3(), 'Petstore 3/default/POST-note.http');
  assert.equal(note.body, 'hello');
});

test('sampleFor: tipe dasar, enum, format, batas kedalaman, XML', () => {
  const s = (schema: unknown) => sampleFor(schema as object, {});
  assert.equal(s({ type: 'string' }), 'string');
  assert.equal(s({ type: 'string', format: 'date' }), '2024-01-01');
  assert.equal(s({ type: 'string', format: 'uuid' }), '00000000-0000-0000-0000-000000000000');
  assert.equal(s({ type: ['string', 'null'] }), 'string', 'OpenAPI 3.1');
  assert.equal(s({ type: 'integer', minimum: 5 }), 5);
  assert.equal(s({ type: 'number' }), 0);
  assert.equal(s({ type: 'boolean' }), true);
  assert.equal(s({ enum: ['x', 'y'] }), 'x');
  assert.equal(s({ type: 'string', default: 'd', example: 'e' }), 'e');
  assert.deepEqual(s({ type: 'array', items: { type: 'integer' } }), [0]);
  assert.deepEqual(s({ allOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { type: 'integer' } } }] }), { a: 'string', b: 0 });
  const deep: Record<string, unknown> = { type: 'object', properties: {} };
  let cur = deep;
  for (let i = 0; i < 20; i++) { const n: Record<string, unknown> = { type: 'object', properties: {} }; (cur.properties as Record<string, unknown>).c = n; cur = n; }
  assert.ok(JSON.stringify(s(deep)).length < 500, 'kedalaman dibatasi');
});

test('security -> Authorization: global _auth.http, per operasi, security: [] = none', () => {
  const a2 = p2();
  assert.match(get(a2, 'Swagger Petstore/_auth.http').content, /^# @auth oauth2 grant=implicit authorization_url=https:\/\/petstore\.swagger\.io\/oauth\/authorize scope=write:pets/);
  assert.equal(req(a2, 'Swagger Petstore/pet/getPetById.http').auth, 'apiKey key=api_key value={{apiKey}} in=header');
  assert.equal(req(a2, 'Swagger Petstore/pet/uploadFile.http').auth, 'none');
  assert.equal(req(a2, 'Swagger Petstore/pet/addPet.http').auth, undefined, 'mewarisi _auth.http');
  const a3 = p3();
  assert.equal(get(a3, 'Petstore 3/_auth.http').content, '# @auth bearer token={{token}}\n');
  assert.equal(req(a3, 'Petstore 3/default/deletePet.http').auth, 'apiKey key=key value={{apiKey}} in=query');
  assert.equal(req(a3, 'Petstore 3/auth/login.http').auth, 'none');
});

test('security: basic, oauth2 flows v3, apiKey cookie, openIdConnect', () => {
  const mk = (schemes: object, sec: object[]) => importOpenApi({ openapi: '3.0.0', info: { title: 'S' }, security: sec, components: { securitySchemes: schemes }, paths: { '/x': { get: {} } } });
  const auth = (schemes: object, sec: object[]) => get(mk(schemes, sec), 'S/_auth.http').content.trim();
  assert.equal(auth({ b: { type: 'http', scheme: 'basic' } }, [{ b: [] }]), '# @auth basic username={{username}} password={{password}}');
  assert.equal(auth({ o: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://t', scopes: { a: '', b: '' } } } } }, [{ o: [] }]),
    '# @auth oauth2 grant=client_credentials token_url=https://t scope="a b" client_id={{clientId}} client_secret={{clientSecret}}');
  assert.equal(auth({ o: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: 'https://a', tokenUrl: 'https://t', scopes: {} } } } }, [{ o: [] }]),
    '# @auth oauth2 grant=authorization_code authorization_url=https://a token_url=https://t client_id={{clientId}} client_secret={{clientSecret}}');
  const c = mk({ k: { type: 'apiKey', in: 'cookie', name: 'sid' } }, [{ k: [] }]);
  assert.ok(!c.files.some((f) => f.path === 'S/_auth.http'), 'cookie: header Cookie per request, bukan _auth');
  assert.equal(req(c, 'S/default/GET-x.http').headers.find((h) => h.name === 'Cookie')?.value, 'sid={{apiKey}}');
  const o = mk({ i: { type: 'openIdConnect', openIdConnectUrl: 'https://idp/.well-known/openid-configuration' } }, [{ i: [] }]);
  assert.match(get(o, 'S/_auth.http').content, /^# @auth oauth2 grant=authorization_code /);
  assert.ok(o.warnings.some((w) => /openid-configuration/.test(w)));
});

test('$ref file relatif lewat loadFile; referensi melingkar antar-file tidak menggantung', () => {
  const files: Record<string, unknown> = {
    'schemas/pet.json': { type: 'object', properties: { id: { type: 'integer' }, owner: { $ref: 'owner.json' } } },
    'schemas/owner.json': { type: 'object', properties: { name: { type: 'string' }, pet: { $ref: 'pet.json' } } },
  };
  const p = importOpenApi({ openapi: '3.0.0', info: { title: 'F' }, paths: { '/p': { post: { operationId: 'p', requestBody: { content: { 'application/json': { schema: { $ref: 'schemas/pet.json' } } } } } } } },
    { loadFile: (rel) => { if (!(rel in files)) throw new Error(`no ${rel}`); return files[rel]; } });
  assert.deepEqual(JSON.parse(req(p, 'F/default/p.http').body), { id: 0, owner: { name: 'string', pet: null } });
});

test('$ref tidak ditemukan -> peringatan, import tetap jalan', () => {
  const p = importOpenApi({ openapi: '3.0.0', info: { title: 'F' }, paths: { '/p': { get: { operationId: 'p', parameters: [{ $ref: '#/components/parameters/Nope' }] } } } });
  assert.ok(p.warnings.some((w) => /Nope/.test(w)));
  assert.ok(get(p, 'F/default/p.http'));
});

test('bukan spec OpenAPI / tanpa paths = error jelas', () => {
  assert.throws(() => importOpenApi({ foo: 1 }), /not an OpenAPI/);
  assert.throws(() => importOpenApi({ openapi: '3.0.0', info: { title: 'x' } }), /no paths/i);
});

test('OpenAPI 3.1: type array + examples; operasi nama file unik', () => {
  const p = importOpenApi({ openapi: '3.1.0', info: { title: 'N' }, servers: [{ url: 'https://n.test' }], paths: {
    '/a': { get: { operationId: 'same' }, post: { operationId: 'same' } },
    '/b': { post: { requestBody: { content: { 'application/json': { examples: { one: { value: { k: 1 } } }, schema: { type: ['object', 'null'] } } } } } },
  } });
  assert.deepEqual(p.files.map((f) => f.path).sort(), ['N/default/POST-b.http', 'N/default/same 2.http', 'N/default/same.http'].sort());
  assert.deepEqual(JSON.parse(req(p, 'N/default/POST-b.http').body), { k: 1 });
  assert.equal(req(p, 'N/default/POST-b.http').url, '{{N_BASE_URL}}/b');
});
