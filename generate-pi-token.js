const jwt = require('jsonwebtoken');
require('dotenv').config();

const hubId = 'pi-2-nimbus-1';
const storeId = 'gallatin_nimbus_298';

const token = jwt.sign(
  {
    hubId: hubId,
    storeId: storeId,
    type: 'hub',
    iat: Math.floor(Date.now() / 1000)
  },
  process.env.MACHINE_JWT_SECRET || process.env.JWT_SECRET,
  { expiresIn: '1y' }
);

console.log('✅ New Pi Token Generated!');
console.log('Hub ID:', hubId);
console.log('Store ID:', storeId);
console.log('Token:', token);
console.log('\nCopy this token to pi-2:/home/gambino/gambino-pi-app/.env');
