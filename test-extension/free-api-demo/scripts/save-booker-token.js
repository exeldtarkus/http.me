// After response: keep the login token in the active Environment (current value, the Environment file is not changed).
const token = httpme.response.json().token;
httpme.test('Login returns a token', () => httpme.expect(token).toBeTruthy());
if (token) httpme.environment.set('BOOKER_TOKEN', token);
