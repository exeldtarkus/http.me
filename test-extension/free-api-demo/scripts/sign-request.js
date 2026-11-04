// Before request: HMAC signature header from the Environment variable SIGNING_SECRET.
const sign = require('./lib/sign');

const ts = String(Date.now());
const secret = httpme.environment.get('SIGNING_SECRET') ?? '';
httpme.request.headers.set('X-Timestamp', ts);
httpme.request.headers.set('X-Signature', sign(secret, ts + (httpme.request.body ?? '')));
console.log('signed with SIGNING_SECRET at', ts);
