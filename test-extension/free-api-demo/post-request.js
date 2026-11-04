// Folder script (After response): runs for every request in free-api-demo/ and its subfolders.
httpme.test('No server error (folder script)', () => httpme.expect(httpme.response.status).toBeLessThan(500));
console.log('<-', httpme.response.status, `${httpme.response.time} ms`);
