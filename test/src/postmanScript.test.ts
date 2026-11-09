import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { translateScript } from '../../src/postmanScript';

const t = (s: string) => translateScript(s);

test('translateScript: environment / variables / collection / globals', () => {
  assert.equal(t('pm.environment.get("a");').code, 'httpme.environment.get("a");');
  assert.equal(t('pm.environment.set("a", 1);').code, 'httpme.environment.set("a", 1);');
  assert.equal(t('pm.environment.unset("a");').code, 'httpme.environment.unset("a");');
  assert.equal(t('pm.variables.get("a")').code, 'httpme.vars.get("a")');
  assert.equal(t('pm.collectionVariables.set("a", 1)').code, 'httpme.collection.set("a", 1)');
  assert.equal(t('pm.globals.get("a")').code, 'httpme.globals.get("a")');
});

test('translateScript: pm.test & response', () => {
  assert.equal(t('pm.test("x", () => {});').code, 'httpme.test("x", () => {});');
  assert.equal(t('const c = pm.response.code;').code, 'const c = httpme.response.status;');
  assert.equal(t('pm.response.status').code, 'httpme.response.statusText');
  assert.equal(t('pm.response.json().a').code, 'httpme.response.json().a');
  assert.equal(t('pm.response.text()').code, 'httpme.response.text()');
  assert.equal(t('pm.response.headers.get("X")').code, 'httpme.response.headers.get("X")');
  assert.equal(t('pm.response.responseTime').code, 'httpme.response.time');
});

test('translateScript: assertion pm.response.to.have.status & pm.expect', () => {
  assert.equal(t('pm.response.to.have.status(200);').code, 'httpme.expect.equal(httpme.response.status, 200);');
  assert.equal(t('pm.expect(a).to.eql(b);').code, 'httpme.expect.deepEqual(a, b);');
  assert.equal(t('pm.expect(a).to.equal(b);').code, 'httpme.expect.equal(a, b);');
  assert.equal(t('pm.expect(a).to.eq(b);').code, 'httpme.expect.equal(a, b);');
  assert.equal(t('pm.expect(a).to.include("x");').code, 'httpme.expect.ok(a.includes("x"));');
  assert.equal(t('pm.expect(a).to.be.true;').code, 'httpme.expect.equal(a, true);');
});

test('translateScript: request & cookies', () => {
  assert.equal(t('pm.request.headers.add({ key: "X", value: "1" });').code, 'httpme.request.headers.set("X", "1");');
  assert.equal(t('pm.request.headers.upsert({ key: "X", value: v });').code, 'httpme.request.headers.set("X", v);');
  assert.equal(t('pm.request.headers.remove("X");').code, 'httpme.request.headers.remove("X");');
  assert.equal(t('pm.request.url').code, 'httpme.request.url');
  assert.equal(t('pm.cookies.get("sid")').code, 'httpme.cookies.get("sid")');
});

test('translateScript: tidak didukung -> komentar + peringatan, baris lain tetap', () => {
  const r = t('const a = 1;\npm.sendRequest("x", cb);\nconst l = require("lodash");\npm.iterationData.get("a");\npm.visualizer.set(t);');
  const lines = r.code.split('\n');
  assert.equal(lines[0], 'const a = 1;');
  assert.match(lines[1], /^\/\/ httpme: not supported — pm\.sendRequest: pm\.sendRequest/);
  assert.match(lines[2], /^\/\/ httpme: not supported — require\(/);
  assert.match(lines[3], /pm\.iterationData/);
  assert.match(lines[4], /pm\.visualizer/);
  assert.equal(r.warnings.length, 4);
});

test('translateScript: pm.* lain yang tak dikenal juga ditandai', () => {
  const r = t('pm.info.requestName');
  assert.match(r.code, /^\/\/ httpme: not supported — pm\.info/);
  assert.equal(r.warnings.length, 1);
});
