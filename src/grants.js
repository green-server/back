import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { config } from './config.js';

const PRIVILEGED_PREFIX = 'greenserver priv ';
const GRANT_SECONDS = 300;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// Derived from GRANT_SECRET, which falls back to JWT_SECRET so an existing deploy keeps its key.
// Set GRANT_SECRET to the current JWT_SECRET before rotating JWT_SECRET.
const seed = createHash('sha256').update(`green-server-grant:${config.grantSecret}`).digest();
const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });

export const grantPublicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

/** Must match message() in server_app/internal/priv. */
export function signGrant(serverId, command, expires, nonce) {
  const message = `green-server-grant-v1\n${serverId}\n${expires}\n${nonce}\n${command}`;
  return { expires, nonce, signature: sign(null, Buffer.from(message), privateKey).toString('base64') };
}

/** Only an owner's decision reaches this. Commands outside `greenserver priv` need no grant. */
export function grantFor(serverId, command) {
  if (!command.startsWith(PRIVILEGED_PREFIX)) return undefined;
  return signGrant(serverId, command, Math.floor(Date.now() / 1000) + GRANT_SECONDS, randomBytes(16).toString('hex'));
}
