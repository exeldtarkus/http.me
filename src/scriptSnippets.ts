// snippet tombol Snippets di tab Scripts (tanpa vscode): disisipkan di posisi kursor
export type Snippet = { title: string; code: string };

export const SNIPPETS: { pre: Snippet[]; post: Snippet[] } = {
  pre: [
    { title: 'Set a request header', code: "httpme.request.headers.set('X-Request-Id', crypto.randomUUID());\n" },
    { title: 'Set an Environment variable', code: "httpme.environment.set('name', 'value');\n" },
    { title: 'Get an Environment variable', code: "const value = httpme.environment.get('name');\n" },
    { title: 'Skip this request', code: "if (!httpme.environment.get('token')) httpme.skip();\n" },
    {
      title: 'HMAC signature header',
      code: "const ts = String(Date.now());\nconst sig = crypto.createHmac('sha256', httpme.environment.get('secret') ?? '').update(ts + (httpme.request.body ?? '')).digest('hex');\nhttpme.request.headers.set('X-Timestamp', ts);\nhttpme.request.headers.set('X-Signature', sig);\n",
    },
  ],
  post: [
    { title: 'Status code is 200', code: "httpme.test('Status code is 200', () => httpme.expect(httpme.response.status).toBe(200));\n" },
    { title: 'Response time below 500 ms', code: "httpme.test('Response time below 500 ms', () => httpme.expect(httpme.response.time).toBeLessThan(500));\n" },
    { title: 'Save a JSON value to the Environment', code: "httpme.environment.set('token', httpme.response.json().token);\n" },
    { title: 'Body contains a string', code: "httpme.test('Body contains a string', () => httpme.expect(httpme.response.text()).toContain('ok'));\n" },
    { title: 'Log the response', code: 'console.log(httpme.response.status, httpme.response.json());\n' },
  ],
};
