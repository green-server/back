// Where a server is, guessed from the public IP its agent connects from (city level).
import { isIP } from 'node:net';

/** The agent's address. Behind the Cloudflare tunnel the socket peer is the proxy, so the header wins. */
export function clientIp(req) {
  const header = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'];
  const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
  const ip = (first || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return isIP(ip) ? ip : null;
}

/** Private, loopback and link-local addresses have no place on a map. */
export function isPublicIp(ip) {
  if (isIP(ip) === 6) return !/^(::1$|fc|fd|fe80)/i.test(ip);
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
}

export async function locate(ip, get = fetch) {
  if (!isPublicIp(ip)) return null;
  const res = await get(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,country_code,latitude,longitude`, {
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json();
  if (!body.success || typeof body.latitude !== 'number' || typeof body.longitude !== 'number') return null;
  const label = [body.city, body.country_code].filter(Boolean).join(', ').slice(0, 120);
  return { lat: body.latitude, lon: body.longitude, label };
}
