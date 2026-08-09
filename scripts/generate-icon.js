#!/usr/bin/env node
// Generates the NOVA orb icon as build/icon.png (256px) and build/icon.ico
// (16/32/48/256 embedded PNGs) using only Node's zlib — no image libraries.
//
// Run: node scripts/generate-icon.js
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, no interlace, single IDAT)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Orb renderer
// ---------------------------------------------------------------------------

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function renderOrb(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const core = 0.16 * size; // bright inner core
  const body = 0.42 * size; // orb body radius
  const glow = 0.5 * size; // outer glow ring

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;

      // Background: near-black navy.
      let r = 0x02;
      let g = 0x02;
      let b = 0x05;
      let a = 255;

      if (dist <= glow) {
        const t = dist / glow;
        const edge = Math.max(0, 1 - t * 1.6);
        // Faint cyan outer halo.
        r = Math.max(r, Math.round(lerp(0, 0, 0)));
        g = Math.max(g, Math.round(lerp(0, 60, 0)));
        b = Math.max(b, Math.round(edge * 40));
        a = 255;
      }

      if (dist <= body) {
        const t = dist / body;
        // Body: bright cyan core -> electric blue -> deep navy rim.
        if (t < core / body) {
          const k = t / (core / body);
          r = Math.round(lerp(0x9f, 0x3d, k));
          g = Math.round(lerp(0xff, 0xe8, k));
          b = Math.round(lerp(0xff, 0xff, k));
        } else {
          const k = (t - core / body) / (1 - core / body);
          r = Math.round(lerp(0x3d, 0x0a, k));
          g = Math.round(lerp(0xe8, 0x2a, k));
          b = Math.round(lerp(0xff, 0x5c, k));
        }
        // Specular highlight offset toward the top-left.
        const hx = x - (cx - body * 0.35);
        const hy = y - (cy - body * 0.4);
        const hd = Math.sqrt(hx * hx + hy * hy);
        if (hd < body * 0.3) {
          const k = 1 - hd / (body * 0.3);
          r = Math.min(255, r + Math.round(k * 90));
          g = Math.min(255, g + Math.round(k * 110));
          b = Math.min(255, b + Math.round(k * 130));
        }
      } else if (dist <= glow) {
        // Thin luminous ring at the orb edge.
        const ring = 1 - Math.abs(dist - body) / (glow - body);
        if (ring > 0) {
          r = Math.round(lerp(r, 0x7d, ring * 0.9));
          g = Math.round(lerp(g, 0xf9, ring * 0.9));
          b = Math.round(lerp(b, 0xff, ring * 0.9));
        }
      }

      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// ICO container (embedded PNG entries — supported by modern Windows)
// ---------------------------------------------------------------------------

function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = [];
  let offset = 6 + entries.length * 16;
  const buffers = [];
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    dir.push(entry);
    buffers.push(png);
  }
  return Buffer.concat([header, ...dir, ...buffers]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const png256 = encodePNG(256, 256, renderOrb(256));
const png48 = encodePNG(48, 48, renderOrb(48));
const png32 = encodePNG(32, 32, renderOrb(32));
const png16 = encodePNG(16, 16, renderOrb(16));

fs.writeFileSync(path.join(outDir, 'icon.png'), png256);
fs.writeFileSync(
  path.join(outDir, 'icon.ico'),
  encodeICO([
    { size: 256, png: png256 },
    { size: 48, png: png48 },
    { size: 32, png: png32 },
    { size: 16, png: png16 },
  ]),
);

console.log('Generated build/icon.png (256x256) and build/icon.ico (16/32/48/256).');
