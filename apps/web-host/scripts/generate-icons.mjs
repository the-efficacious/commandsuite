#!/usr/bin/env node
/**
 * Icon sync for the csuite web app — canonical artwork only.
 *
 * Copies the CommandSuite app icon from `@the-efficacious/brand`'s
 * logo pack into `public/`, and resamples the one size the pack does
 * not ship (192, required by PWA installability checks) from the
 * 512px original. No artwork is drawn here — the brand package is the
 * single source of the mark, and this script only moves pixels.
 *
 * PNG handling is `node:zlib` + a hand-rolled chunk reader/writer (no
 * sharp or native deps, so `pnpm install` in CI doesn't need a build
 * toolchain). The pack's PNGs are 8-bit RGBA non-interlaced, which is
 * the only layout the decoder accepts — it fails loudly otherwise.
 *
 * Run after bumping the brand package, commit the results:
 *
 *   node apps/web-host/scripts/generate-icons.mjs
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');
const require = createRequire(import.meta.url);
const brandRoot = dirname(require.resolve('@the-efficacious/brand/package.json'));
const pack = (rel) => join(brandRoot, 'logo-pack', rel);

/* ─────────────────────────── PNG codec ─────────────────────────── */

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Decode an 8-bit RGBA non-interlaced PNG into { width, height, rgba }. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const color = data[9];
      const interlace = data[12];
      if (depth !== 8 || color !== 6 || interlace !== 0) {
        throw new Error(
          `unsupported PNG layout (depth=${depth} color=${color} interlace=${interlace}) — expected 8-bit RGBA non-interlaced`,
        );
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    const prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[out + x - 4] : 0;
      const b = y > 0 ? rgba[prev + x] : 0;
      const c = y > 0 && x >= 4 ? rgba[prev + x - 4] : 0;
      let v = rowIn[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      rgba[out + x] = v & 0xff;
    }
  }
  return { width, height, rgba };
}

/** Encode 8-bit RGBA pixels as a PNG (filter 0 rows). */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Box-filter resample (area averaging) — fine for downscales. */
function resample(src, dstW, dstH) {
  const dst = Buffer.alloc(dstW * dstH * 4);
  const xr = src.width / dstW;
  const yr = src.height / dstH;
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor(y * yr);
    const y1 = Math.min(Math.ceil((y + 1) * yr), src.height);
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor(x * xr);
      const x1 = Math.min(Math.ceil((x + 1) * xr), src.width);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.rgba[i];
          g += src.rgba[i + 1];
          b += src.rgba[i + 2];
          a += src.rgba[i + 3];
          n++;
        }
      }
      const o = (y * dstW + x) * 4;
      dst[o] = Math.round(r / n);
      dst[o + 1] = Math.round(g / n);
      dst[o + 2] = Math.round(b / n);
      dst[o + 3] = Math.round(a / n);
    }
  }
  return dst;
}

/* ─────────────────────────── sync ─────────────────────────── */

mkdirSync(join(publicDir, 'icons'), { recursive: true });

// Straight copies — canonical renders from the pack.
copyFileSync(
  pack('png/commandsuite/commandsuite-appicon-dark-512.png'),
  join(publicDir, 'icons', 'icon-512.png'),
);
copyFileSync(
  pack('png/commandsuite/commandsuite-appicon-dark-180.png'),
  join(publicDir, 'apple-touch-icon.png'),
);
// Favicon: the pack's square appicon insets the symbol to 67% of the
// tile, and the symbol file itself only inks 80×57 of its 100-unit
// viewBox — at 16px that leaves a ~9px mark. Recompose the same two
// canonical pieces with the inner placement rewritten: crop the
// symbol's viewBox to its ink (10..90 × 21.5..78.5) and fit it to 86%
// of the tile width, vertically centered. Artwork bytes are untouched;
// only the nesting <svg> geometry changes.
{
  const square = readFileSync(
    pack('svg/commandsuite/commandsuite-appicon-dark-square.svg'),
    'utf8',
  );
  const tight = square.replace(
    /<svg x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" viewBox="0 0 100 100">/,
    '<svg x="7" y="19.36" width="86" height="61.28" viewBox="10 21.5 80 57">',
  );
  if (tight === square)
    throw new Error('favicon recompose: inner <svg> placement not found — pack layout changed?');
  writeFileSync(join(publicDir, 'favicon.svg'), tight);
}
copyFileSync(pack('svg/commandsuite/commandsuite-symbol-dark.svg'), join(publicDir, 'logo.svg'));

// 192 — the one PWA-required size the pack doesn't ship; resampled
// from the 512 original.
const src512 = decodePng(readFileSync(pack('png/commandsuite/commandsuite-appicon-dark-512.png')));
writeFileSync(
  join(publicDir, 'icons', 'icon-192.png'),
  encodePng(192, 192, resample(src512, 192, 192)),
);

console.log('icons synced from @the-efficacious/brand logo pack');
