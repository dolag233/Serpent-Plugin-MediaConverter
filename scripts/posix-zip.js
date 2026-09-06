'use strict';

const { readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { crc32, deflateRawSync } = require('node:zlib');

function listPackageFiles(root) {
  const files = [];
  const visit = (relativeDirectory) => {
    const directory = relativeDirectory ? path.join(root, ...relativeDirectory.split('/')) : root;
    for (const name of readdirSync(directory).sort()) {
      if (name === '.' || name === '..') continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const fullPath = path.join(root, ...relativePath.split('/'));
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        visit(relativePath);
        continue;
      }
      if (!stats.isFile()) continue;
      files.push(relativePath);
    }
  };
  visit('');
  return files;
}

function listZipLocalNames(buffer) {
  const names = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    names.push(buffer.subarray(nameStart, nameStart + nameLength).toString('utf8'));
    offset = nameStart + nameLength + extraLength + compressedSize;
  }
  return names;
}

function writePosixZip(root, zipPath) {
  const files = listPackageFiles(root);
  const chunks = [];
  const records = [];
  let offset = 0;

  for (const relativePath of files) {
    const data = readFileSync(path.join(root, ...relativePath.split('/')));
    const name = Buffer.from(relativePath, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, compressed);
    records.push({
      name,
      crc,
      compressedSize: compressed.length,
      size: data.length,
      offset,
    });
    offset += 30 + name.length + compressed.length;
  }

  const centralDirectoryOffset = offset;
  for (const record of records) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(record.crc, 16);
    central.writeUInt32LE(record.compressedSize, 20);
    central.writeUInt32LE(record.size, 24);
    central.writeUInt16LE(record.name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
    central.writeUInt32LE(record.offset, 42);
    chunks.push(central, record.name);
    offset += 46 + record.name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(offset - centralDirectoryOffset, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);
  writeFileSync(zipPath, Buffer.concat(chunks));
  return files;
}

module.exports = {
  listPackageFiles,
  listZipLocalNames,
  writePosixZip,
};
