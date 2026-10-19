'use strict';
// Minimal ZIP reader (stored + deflate entries): enough to open a .crx or .xpi in a test.
// A .crx is a ZIP with a header in front: CRX2 = "Cr24", version 2, public-key length,
// signature length, key, signature, ZIP; CRX3 = "Cr24", version 3, header length, header, ZIP.
const zlib = require('node:zlib');

function zipPayload(buf) {
  if (buf.toString('latin1', 0, 4) !== 'Cr24') return buf;
  const version = buf.readUInt32LE(4);
  if (version === 2) return buf.subarray(16 + buf.readUInt32LE(8) + buf.readUInt32LE(12));
  if (version === 3) return buf.subarray(12 + buf.readUInt32LE(8));
  throw new Error('unknown crx version ' + version);
}

function centralDirectory(zip) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central-directory entry at ' + p);
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, csize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipEntryNames(buf) {
  return [...centralDirectory(zipPayload(buf)).keys()];
}

function readZipEntry(buf, name) {
  const zip = zipPayload(buf);
  const e = centralDirectory(zip).get(name);
  if (!e) throw new Error('no zip entry ' + name);
  if (zip.readUInt32LE(e.localOffset) !== 0x04034b50) throw new Error('bad local header for ' + name);
  const nameLen = zip.readUInt16LE(e.localOffset + 26);
  const extraLen = zip.readUInt16LE(e.localOffset + 28);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const data = zip.subarray(start, start + e.csize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error('unsupported compression method ' + e.method + ' for ' + name);
}

module.exports = { zipPayload, zipEntryNames, readZipEntry };
