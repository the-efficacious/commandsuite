#!/usr/bin/env node
/**
 * Heptagon-mark PNG icon generator for the csuite web app.
 *
 * Writes `public/icons/icon-192.png` and `public/icons/icon-512.png`
 * with the Classic-Mesh heptagon mark (steel on paper) for PWA installs.
 * Encodes PNG from scratch using `node:zlib` + a hand-rolled CRC32 — no
 * `sharp` or native deps, so `pnpm install` in CI doesn't need a prebuild
 * cache or build toolchain.
 *
 * The mark is drawn at 80% scale to satisfy the `purpose: "any maskable"`
 * declaration in manifest.webmanifest — PWA installers may crop down to
 * a circle of radius 0.4·size, and this keeps every node inside that zone.
 *
 * Run once after brand changes, commit the resulting PNGs:
 *
 *   node apps/web-host/scripts/generate-icons.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/* ──────────────────────────── brand ──────────────────────────── */

// Steel (#3E5C76) on paper (#F6F3EC). Matches theme.css tokens and the
// Classic-Mesh winner from logo-workshop-classic-mesh.html.
const FG = [0x3e, 0x5c, 0x76];
const BG = [0xf6, 0xf3, 0xec];

// Heptagon in a 120×120 logical space (center at 60,60, radius 45).
// Shrunk to 80% around the center so maskable crops don't clip nodes.
const CENTER = 60;
const MASK_SCALE = 0.8;
const STROKE_HALF = (3 / 2) * MASK_SCALE; // polygon stroke width / 2
const NODE_R = 10 * MASK_SCALE;

const RAW_VERTS = [
  [60, 15],
  [95.18, 31.94],
  [103.87, 70.01],
  [79.52, 100.54],
  [40.48, 100.54],
  [16.13, 70.01],
  [24.82, 31.94],
];
const VERTS = RAW_VERTS.map(([x, y]) => [
  CENTER + (x - CENTER) * MASK_SCALE,
  CENTER + (y - CENTER) * MASK_SCALE,
]);

/* ──────────────────────────── SDF ──────────────────────────── */

// Signed distance from point (px,py) to segment (ax,ay)-(bx,by).
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Returns true if (px,py) is inside the mark (polygon stroke OR any node circle).
function inside(px, py) {
  for (const [cx, cy] of VERTS) {
    if (Math.hypot(px - cx, py - cy) <= NODE_R) return true;
  }
  for (let i = 0; i < VERTS.length; i++) {
    const [ax, ay] = VERTS[i];
    const [bx, by] = VERTS[(i + 1) % VERTS.length];
    if (segDist(px, py, ax, ay, bx, by) <= STROKE_HALF) return true;
  }
  return false;
}

/* ──────────────────────────── PNG ──────────────────────────── */

// CRC32 lookup table (standard PNG polynomial 0xedb88320).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcSrc = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcSrc), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Rasterize the heptagon mark to an RGBA PNG at the given size. Uses 4×4
 * supersampling (16 coverage samples per output pixel) for soft edges —
 * the polygon stroke stays crisp even at 192 px because the mark sits in
 * a 120-unit logical space scaled up.
 */
function makeMarkPng(size) {
  const width = size;
  const height = size;
  const rowLen = 1 + width * 4; // filter byte + RGBA
  const raw = Buffer.alloc(rowLen * height);
  const scale = size / 120;
  const sub = 4; // supersample grid side
  const subStep = 1 / scale / sub;
  const subOffsets = [];
  for (let i = 0; i < sub; i++) subOffsets.push((i - (sub - 1) / 2) * subStep);
  const subCount = sub * sub;

  for (let y = 0; y < height; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0; // filter: None
    const py = (y + 0.5) / scale;
    for (let x = 0; x < width; x++) {
      const px = (x + 0.5) / scale;
      let hits = 0;
      for (const dy of subOffsets) {
        for (const dx of subOffsets) {
          if (inside(px + dx, py + dy)) hits++;
        }
      }
      const cov = hits / subCount;
      const p = rowStart + 1 + x * 4;
      raw[p] = Math.round(BG[0] * (1 - cov) + FG[0] * cov);
      raw[p + 1] = Math.round(BG[1] * (1 - cov) + FG[1] * cov);
      raw[p + 2] = Math.round(BG[2] * (1 - cov) + FG[2] * cov);
      raw[p + 3] = 0xff;
    }
  }
  const idat = deflateSync(raw, { level: 9 });

  // IHDR: width(4) height(4) bit-depth(1=8) color-type(1=6 RGBA) compression(1=0) filter(1=0) interlace(1=0)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const png = makeMarkPng(size);
  const out = join(outDir, `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${size}x${size}, ${png.length} bytes)`);
}
