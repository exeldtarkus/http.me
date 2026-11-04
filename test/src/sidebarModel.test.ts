import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { arrangeOpen, defaultFileName, filterFiles, folderChildren, moveInOrder, openChildren, requestSummary, UNTITLED } from '../../src/sidebarModel';

test('folderChildren: folder dulu lalu file, urut nama; folder kosong (.httpmekeep) ikut; tampilan rata', () => {
  const files = ['api/auth/login.http', 'api/users.http', 'b.http', 'a.http'];
  const keep = ['api/empty', 'docs'];
  assert.deepEqual(folderChildren(files, keep, '', false), { folders: ['api', 'docs'], files: ['a.http', 'b.http'] });
  assert.deepEqual(folderChildren(files, keep, 'api', false), { folders: ['api/auth', 'api/empty'], files: ['api/users.http'] });
  assert.deepEqual(folderChildren(files, keep, 'api/empty', false), { folders: [], files: [] });
  assert.deepEqual(folderChildren(files, keep, '', true), { folders: [], files: ['a.http', 'api/auth/login.http', 'api/users.http', 'b.http'] });
});

test('requestSummary: method + host request pertama, judul ###; {{var}} di host dipertahankan', () => {
  assert.deepEqual(requestSummary('### Login\nPOST https://api.test:8443/login\n'), { method: 'POST', host: 'api.test:8443', url: 'https://api.test:8443/login', title: 'Login', count: 1 });
  assert.deepEqual(requestSummary('GET {{baseUrl}}/users\n'), { method: 'GET', host: '{{baseUrl}}', url: '{{baseUrl}}/users', title: undefined, count: 1 });
  assert.deepEqual(requestSummary('### A\nGET https://a/1\n###\nDELETE https://b/2\n'), { method: 'GET', host: 'a', url: 'https://a/1', title: 'A', count: 2 });
  assert.deepEqual(requestSummary('# kosong\n'), { method: undefined, host: '', url: '', title: undefined, count: 0 });
});

test('filterFiles: cocok nama file, method, atau URL (tanpa beda huruf besar); kosong = semua', () => {
  const items = [
    { path: 'auth/login.http', method: 'POST', url: 'https://api.test/login' },
    { path: 'users.http', method: 'GET', url: '{{base}}/users' },
  ];
  assert.deepEqual(filterFiles(items, '').map((i) => i.path), ['auth/login.http', 'users.http']);
  assert.deepEqual(filterFiles(items, 'LOGIN').map((i) => i.path), ['auth/login.http']);
  assert.deepEqual(filterFiles(items, 'get').map((i) => i.path), ['users.http']);
  assert.deepEqual(filterFiles(items, '{{base}}').map((i) => i.path), ['users.http']);
  assert.deepEqual(filterFiles(items, 'auth').map((i) => i.path), ['auth/login.http'], 'nama folder ikut dicocokkan');
});

const tab = (rel: string, o: { untitled?: boolean; dirty?: boolean } = {}) => ({ uri: `u:${rel}`, rel, untitled: !!o.untitled, dirty: !!o.dirty });

test('openChildren: folder + grup Untitled + file; tanda ● naik ke folder induk; filter Unsaved; tampilan rata', () => {
  const tabs = [tab('api/auth/login.http', { dirty: true }), tab('api/users.http'), tab('root.http'), tab('New Request 1.http', { untitled: true, dirty: true })];
  const root = openChildren(tabs, '', false, false);
  assert.deepEqual(root.folders, [{ rel: 'api', dirty: true }]);
  assert.deepEqual(root.untitled, { count: 1, dirty: true });
  assert.deepEqual(root.files.map((t) => t.rel), ['root.http']);
  assert.deepEqual(openChildren(tabs, 'api', false, false).folders, [{ rel: 'api/auth', dirty: true }]);
  assert.deepEqual(openChildren(tabs, 'api', false, false).files.map((t) => t.rel), ['api/users.http']);
  assert.deepEqual(openChildren(tabs, UNTITLED, false, false).files.map((t) => t.rel), ['New Request 1.http']);
  const unsaved = openChildren(tabs, '', false, true);
  assert.deepEqual([unsaved.folders.map((f) => f.rel), unsaved.files.length, unsaved.untitled?.count], [['api'], 0, 1]);
  assert.deepEqual(openChildren(tabs, '', true, false).files.map((t) => t.rel), ['api/auth/login.http', 'api/users.http', 'root.http', 'New Request 1.http']);
  assert.equal(openChildren(tabs, '', true, false).untitled, undefined);
});

test('arrangeOpen / moveInOrder: pin di atas, urutan tersimpan, drag memindah sebelum target', () => {
  const items = ['a', 'b', 'c', 'd'].map((uri) => ({ uri }));
  assert.deepEqual(arrangeOpen(items, ['c', 'a'], ['d']).map((x) => `${x.uri}${x.pinned ? '*' : ''}`), ['d*', 'c', 'a', 'b']);
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], ['c'], 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], ['a'], undefined), ['b', 'c', 'a']);
  assert.deepEqual(moveInOrder(['a', 'b'], ['a'], 'a'), ['a', 'b']);
});

test('defaultFileName: dua segmen path terakhir digabung "-", query & {{var}} host dibuang, karakter ilegal diganti', () => {
  assert.equal(defaultFileName('{{baseUrl}}/pos/log/post'), 'log-post.http');
  assert.equal(defaultFileName('https://api.test/users?page=2'), 'users.http');
  assert.equal(defaultFileName('https://api.test/users/{{id}}'), 'users-id.http');
  assert.equal(defaultFileName('https://api.test/'), 'request.http');
  assert.equal(defaultFileName(''), 'request.http');
  assert.equal(defaultFileName('https://a/x:y*z'), 'x-y-z.http');
});
