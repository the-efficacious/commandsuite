#!/usr/bin/env node
// Print the current 6-digit TOTP code for a base32 secret (RFC 6238,
// SHA-1, 30 s, 6 digits — what `csuite setup` enrolls). No dependencies,
// so the bootstrap sequence can prove a web-UI sign-in from any box
// that has node. Usage: node totp.mjs <secret-file>
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: totp.mjs <secret-file>');
  process.exit(2);
}
const secret = readFileSync(file, 'utf8').trim().replace(/=+$/, '').toUpperCase();
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let bits = '';
for (const c of secret) {
  const v = ALPHABET.indexOf(c);
  if (v < 0) {
    console.error(`totp.mjs: not base32: ${c}`);
    process.exit(2);
  }
  bits += v.toString(2).padStart(5, '0');
}
const key = Buffer.from(bits.match(/.{8}/g).map((b) => Number.parseInt(b, 2)));
const counter = Buffer.alloc(8);
counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
const h = createHmac('sha1', key).update(counter).digest();
const o = h[h.length - 1] & 0xf;
const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
process.stdout.write(code);
