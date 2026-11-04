// After response: check the created booking and keep its id for 05-booker-update.http.
const json = httpme.response.json();
httpme.test('Status code is 200', () => httpme.expect(httpme.response.status).toBe(200));
httpme.test('Booking has an id', () => httpme.expect(json).toHaveProperty('bookingid'));
httpme.test('Guest name from the pre-request script', () => httpme.expect(json.booking.firstname).toBe(httpme.vars.get('guest')));
if (json.bookingid) httpme.environment.set('BOOKING_ID', json.bookingid);
