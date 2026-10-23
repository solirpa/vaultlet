// Derive the Chrome extension id from keys/public.der (SubjectPublicKeyInfo DER).
// id = first 32 hex chars (16 bytes) of SHA-256(DER), each hex nibble mapped to a-p.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function readPublicKeyDer() {
  return readFileSync(resolve(root, 'keys/public.der'));
}

export function extensionIdFromDer(der) {
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function publicKeyBase64() {
  return readPublicKeyDer().toString('base64');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = extensionIdFromDer(readPublicKeyDer());
  writeFileSync(resolve(root, 'EXTENSION_ID'), id + '\n');
  console.log(id);
}
