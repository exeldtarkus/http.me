import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { beautifyBody } from '../../src/beautify';

test('beautifyBody JSON: indent 2 spasi, {{variable}} di dalam / di luar string tetap utuh', () => {
  assert.deepEqual(beautifyBody('{"a":1,"b":[true,null]}', 'json'), { text: '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}' });
  assert.deepEqual(beautifyBody('{"title":"demo {{$uuid}}","userId":{{POST_ID}},"x":"a\\"{{b}}"}', 'json'),
    { text: '{\n  "title": "demo {{$uuid}}",\n  "userId": {{POST_ID}},\n  "x": "a\\"{{b}}"\n}' });
  assert.deepEqual(beautifyBody('{{body}}', 'json'), { text: '{{body}}' });
  assert.deepEqual(beautifyBody('{"a":"{{v}}"}', 'json'), { text: '{\n  "a": "{{v}}"\n}' }, 'string berisi variable saja tetap berkutip');
  assert.match(beautifyBody('{"a":', 'json').error!, /^Body is not valid JSON/);
});

test('beautifyBody XML: dirapikan; bukan XML = error; jenis lain = error', () => {
  assert.deepEqual(beautifyBody('<a><b>{{v}}</b><c x="1"/></a>', 'xml'), { text: '<a>\n  <b>{{v}}</b>\n  <c x="1"/>\n</a>' });
  assert.match(beautifyBody('hello', 'xml').error!, /not valid XML/);
  assert.match(beautifyBody('x', 'text').error!, /JSON or XML/);
});

test('review R27: Beautify memperbaiki JSON longgar (key tanpa kutip, kutip tunggal, koma akhir, komentar), {{variable}} utuh', () => {
  assert.deepEqual(beautifyBody('{\n  name: "exel",\n  kelas: "10"\n}', 'json'), { text: '{\n  "name": "exel",\n  "kelas": "10"\n}' });
  assert.deepEqual(beautifyBody(`{'a': 'it\\'s "x"', b: [1,2,],} // c\n/* d */`, 'json'), { text: '{\n  "a": "it\'s \\"x\\"",\n  "b": [\n    1,\n    2\n  ]\n}' });
  assert.deepEqual(beautifyBody(`{id: {{ID}}, t: '{{v}}', ok: true}`, 'json'), { text: '{\n  "id": {{ID}},\n  "t": "{{v}}",\n  "ok": true\n}' });
  assert.deepEqual(beautifyBody('{"x":"a: b, }","y":"// no"}', 'json'), { text: '{\n  "x": "a: b, }",\n  "y": "// no"\n}' }, 'isi string tidak disentuh');
  assert.match(beautifyBody('{name "exel"}', 'json').error!, /^Body is not valid JSON/, 'tidak bisa diperbaiki = error, body tidak diubah');
});
