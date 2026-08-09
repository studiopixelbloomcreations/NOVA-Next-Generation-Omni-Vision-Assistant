// Pack build/ico-sizes/icon-{16..256}.png into a single multi-resolution
// build/icon.ico (ICO container with PNG-compressed entries, supported since
// Windows Vista — the format electron-builder ships in the installer/exe).
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const dir = path.join('build', 'ico-sizes');

const entries = [];
let offset = 6 + SIZES.length * 16; // ICONDIR header + ICONDIRENTRY[] header
for (const size of SIZES) {
  const file = path.join(dir, `icon-${size}.png`);
  const data = fs.readFileSync(file);
  const dim = size >= 256 ? 0 : size; // 0 means 256 in the ICO spec
  entries.push({
    width: dim,
    height: dim,
    colors: 0,
    reserved: 0,
    planes: 1,
    bitCount: 32,
    bytesInRes: data.length,
    imageOffset: offset,
    data,
  });
  offset += data.length;
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type: icon
header.writeUInt16LE(entries.length, 4);

const chunks = [header];
for (const e of entries) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(e.width, 0);
  entry.writeUInt8(e.height, 1);
  entry.writeUInt8(e.colors, 2);
  entry.writeUInt8(e.reserved, 3);
  entry.writeUInt16LE(e.planes, 4);
  entry.writeUInt16LE(e.bitCount, 6);
  entry.writeUInt32LE(e.bytesInRes, 8);
  entry.writeUInt32LE(e.imageOffset, 12);
  chunks.push(entry);
}
for (const e of entries) chunks.push(e.data);

const out = Buffer.concat(chunks);
fs.writeFileSync(path.join('build', 'icon.ico'), out);
console.log(`wrote build/icon.ico (${out.length} bytes, ${entries.length} sizes: ${SIZES.join(',')})`);
