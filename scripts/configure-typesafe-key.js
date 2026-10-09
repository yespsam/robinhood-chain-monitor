import { startTypesafeKeySetup } from '../src/typesafe-key-setup.js';
const setup = await startTypesafeKeySetup();
console.log(JSON.stringify({ status: 'awaiting_user', url: setup.url, expiresInMinutes: 15, externalRequests: 0 }));
process.on('SIGINT', setup.close); process.on('SIGTERM', setup.close);
