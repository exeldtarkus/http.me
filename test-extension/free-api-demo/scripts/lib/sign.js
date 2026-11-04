// Local module: require('./lib/sign') from a script. Only crypto / buffer / url / querystring / util and .js files in the repo can be required.
const crypto = require('crypto');

module.exports = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
