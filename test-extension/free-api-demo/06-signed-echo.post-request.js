// This request's own script (After response): the file next to 06-signed-echo.http, runs last.
const echo = httpme.response.json();
const sent = (name) => (echo.headers[name] ?? [])[0];
httpme.test('Signature header was sent', () => httpme.expect(sent('X-Signature')).toMatch(/^[0-9a-f]{64}$/));
httpme.test('Request id from the folder script was sent', () => httpme.expect(sent('X-Request-Id')).toBeTruthy());
httpme.test('Body was sent as JSON', () => httpme.expect(echo.json).toEqual({ order: 42, note: 'signed by http.me' }));
