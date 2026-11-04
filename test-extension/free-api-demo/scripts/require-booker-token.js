// Before request: skip the request (it is not sent) until 03-booker-login.http has saved BOOKER_TOKEN.
if (!httpme.environment.get('BOOKER_TOKEN')) {
  console.warn('BOOKER_TOKEN is empty: send 03-booker-login.http first');
  httpme.skip();
}
