// Before request: build the JSON body in the script (random guest, check-in tomorrow for 2 nights).
const names = ['Ayu', 'Budi', 'Citra', 'Dewi', 'Eko'];
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const firstname = names[Math.floor(Math.random() * names.length)];
httpme.vars.set('guest', firstname);
httpme.request.body = JSON.stringify({
  firstname, lastname: 'Demo', totalprice: 150, depositpaid: true,
  bookingdates: { checkin: day(1), checkout: day(3) }, additionalneeds: 'Breakfast',
}, null, 2);
