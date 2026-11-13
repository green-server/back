import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientIp, isPublicIp, locate } from '../src/geo.js';

const req = (headers, remoteAddress = '::ffff:172.18.0.5') =>
  ({ headers, socket: { remoteAddress } });

test('clientIp prefers the proxy headers over the socket', () => {
  assert.equal(clientIp(req({ 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(clientIp(req({ 'x-forwarded-for': '198.51.100.2, 10.0.0.1' })), '198.51.100.2');
  assert.equal(clientIp(req({})), '172.18.0.5');
  assert.equal(clientIp(req({ 'cf-connecting-ip': 'nonsense' }, '')), null);
});

test('private addresses are never looked up', async () => {
  for (const ip of ['10.1.2.3', '192.168.0.1', '172.20.0.1', '127.0.0.1', '100.90.86.76', '::1', 'fd00::1']) assert.equal(isPublicIp(ip), false, ip);
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(await locate('192.168.0.1', () => assert.fail('fetched')), null);
});

test('locate reads city, country and coordinates', async () => {
  const fake = async () => Response.json({ success: true, city: 'Seoul', country_code: 'KR', latitude: 37.56, longitude: 126.97 });
  assert.deepEqual(await locate('8.8.8.8', fake), { lat: 37.56, lon: 126.97, label: 'Seoul, KR' });
  const failed = async () => Response.json({ success: false });
  assert.equal(await locate('8.8.8.8', failed), null);
});
