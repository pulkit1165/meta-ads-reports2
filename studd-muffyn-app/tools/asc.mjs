// App Store Connect API client (permanent home — scratchpad gets wiped).
// Usage: node -e "import('./asc.mjs').then(async ({api}) => { ... })"
import jwt from 'jsonwebtoken';
import fs from 'fs';

const KEY = fs.readFileSync(new URL('../app/credentials/AuthKey_485W9438M3.p8', import.meta.url));
export const APP_ID = '1597059141';
export const VERSION_ID = '00c8a166-082e-4d38-835e-c87ede4da5f5';

export function token() {
  return jwt.sign({}, KEY, {
    algorithm: 'ES256', expiresIn: '15m',
    issuer: '0e0ce657-801b-4c95-b81f-aa982d5a505f',
    audience: 'appstoreconnect-v1',
    header: { alg: 'ES256', kid: '485W9438M3', typ: 'JWT' },
  });
}

export async function api(method, path, body) {
  const r = await fetch('https://api.appstoreconnect.apple.com' + path, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${text.slice(0, 600)}`);
  return j;
}
