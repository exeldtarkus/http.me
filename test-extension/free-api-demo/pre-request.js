// Folder script (Before request): runs for every request in free-api-demo/ and its subfolders, before the request's own scripts.
httpme.request.headers.set('X-Request-Id', crypto.randomUUID());
console.log('->', httpme.request.method, httpme.request.url);
