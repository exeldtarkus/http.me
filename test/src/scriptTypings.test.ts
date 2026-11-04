import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SCRIPT_TYPINGS, jsconfigText } from '../../src/scriptTypings';

test('httpme.d.ts: mendeklarasikan semua API httpme yang ada di runner', () => {
  for (const name of ['request', 'response', 'environment', 'vars', 'cookies', 'test', 'expect', 'skip']) assert.match(SCRIPT_TYPINGS, new RegExp(`\\b${name}\\b`), name);
  for (const m of ['toBe', 'toEqual', 'toContain', 'toMatch', 'toBeTruthy', 'toBeFalsy', 'toBeLessThan', 'toBeGreaterThan', 'toHaveProperty', 'not']) assert.match(SCRIPT_TYPINGS, new RegExp(`\\b${m}\\b`), m);
  assert.match(SCRIPT_TYPINGS, /declare const httpme: Httpme;/);
  assert.match(SCRIPT_TYPINGS, /'crypto' \| 'buffer' \| 'url' \| 'querystring' \| 'util'/);
});

test('jsconfigText: jsconfig baru menyertakan httpme.d.ts; jsconfig lama tidak ditimpa (undefined)', () => {
  const j = JSON.parse(jsconfigText(undefined)!);
  assert.deepEqual(j.compilerOptions.lib, ['es2022']);
  assert.equal(jsconfigText('{"compilerOptions":{}}'), undefined);
});
