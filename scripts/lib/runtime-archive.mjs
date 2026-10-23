/** Deterministic, streaming USTAR/gzip writer matching the runtime installer. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function header(name, size, directory, executable) {
 const h = Buffer.alloc(512);
 const put = (offset, length, value) => {
  if (Buffer.byteLength(value) > length) throw new Error(`USTAR field exceeds limit: ${name}`);
  h.write(value, offset, length);
 };
 let leaf = name, prefix = '';
 if (Buffer.byteLength(name) > 100) {
  const parts = name.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
   const a = parts.slice(0, i).join('/'), b = parts.slice(i).join('/');
   if (Buffer.byteLength(a) <= 155 && Buffer.byteLength(b) <= 100) { prefix = a; leaf = b; break; }
  }
 }
 const octal = (offset, length, value) => put(offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
 put(0, 100, leaf); octal(100, 8, directory || executable ? 0o755 : 0o644);
 octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, size); octal(136, 12, 0);
 put(148, 8, '        '); put(156, 1, directory ? '5' : '0');
 put(257, 6, 'ustar\0'); put(263, 2, '00'); put(345, 155, prefix);
 put(148, 8, h.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ');
 return h;
}
export async function createComponentArchive(directory, output) {
 const entries = []; let unpackedBytes = 0;
 function walk(dir, relative = '') {
  for (const name of fs.readdirSync(dir).sort()) {
   const file = path.join(dir, name), stat = fs.lstatSync(file), entry = relative ? `${relative}/${name}` : name;
   if (stat.isSymbolicLink()) throw new Error(`组件归档不得包含链接：${file}`);
   if (!stat.isDirectory() && !stat.isFile()) throw new Error(`组件包含非普通文件：${file}`);
   entries.push({ file, stat, header: header(entry, stat.isDirectory() ? 0 : stat.size, stat.isDirectory(), Boolean(stat.mode & 0o111)) });
   if (stat.isDirectory()) walk(file, entry); else unpackedBytes += stat.size;
  }
 }
 walk(directory); fs.mkdirSync(path.dirname(output), { recursive: true });
 async function* tar() {
  for (const entry of entries) {
   yield entry.header;
   if (!entry.stat.isFile()) continue;
   let bytes = 0;
   for await (const chunk of fs.createReadStream(entry.file)) { bytes += chunk.length; yield chunk; }
   if (bytes !== entry.stat.size) throw new Error(`Component changed during packaging: ${entry.file}`);
   const padding = (512 - bytes % 512) % 512;
   if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1024);
 }
 try { await pipeline(Readable.from(tar()), createGzip({ level: 9 }), fs.createWriteStream(output)); }
 catch (error) { fs.rmSync(output, { force: true }); throw error; }
 const hash = createHash('sha256');
 for await (const chunk of fs.createReadStream(output)) hash.update(chunk);
 return { sha256: hash.digest('hex'), bytes: fs.statSync(output).size, unpackedBytes };
}
