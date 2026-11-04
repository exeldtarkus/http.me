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
