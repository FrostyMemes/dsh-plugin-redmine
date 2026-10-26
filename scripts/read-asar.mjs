import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
export function readAsar(archive, entry) {
  const fd = fs.openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(12)); fs.readSync(fd, header, 0, header.length, 16);
    const tree = JSON.parse(header.toString());
    const node = entry.split('/').reduce((parent, key) => parent?.files?.[key], tree);
    if (!node || node.files || node.unpacked) throw new Error(`Not a packed file: ${entry}`);
    const data = Buffer.alloc(node.size); fs.readSync(fd, data, 0, data.length, 8 + prefix.readUInt32LE(4) + Number(node.offset));
    return data.toString();
  } finally { fs.closeSync(fd); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(readAsar(process.argv[2], process.argv[3]));
}
