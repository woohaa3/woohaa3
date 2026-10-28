const pngInflations = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:zlib', async (importOriginal) => { const original: any = await importOriginal(); return { ...original, inflateSync: (...args: any[]) => { pngInflations.count++; return original.inflateSync(...args); } }; });
import { describe, expect, it, vi } from 'vitest';
import { decodeScenePackage, encodeScenePackage, finalizeScenePackageManifest } from './archive.js';
const canvas: any = { id: 'sample', revision: 0, title: 'Sample', document: { schemaVersion: 'asset-canvas-v1', nodes: [{ id: 'n', type: 'text', position: { x: 0, y: 0 } }], edges: [], updatedAt: '2026-01-01T00:00:00.000Z' }, nodeData: { n: { prompt: 'hello' } }, assets: [], jobs: [], updatedAt: '2026-01-01T00:00:00.000Z' };
const fixture = () => ({ manifest: { format: 'woohaa-scene', version: 1, datasetId: 'sample', contentHash: '', recipeVersion: 1, kind: 'text', title: 'Sample', views: { overview200: ['n'], overview300: ['n'], distant: [] }, media: [] } as any, canvas, media: new Map<string, Uint8Array>() });
describe('scene archive', () => {
    it('round trips and verifies intrinsic identity', async () => { const p = fixture(); p.manifest = finalizeScenePackageManifest(p.manifest, p.canvas); const decoded = await decodeScenePackage(encodeScenePackage(p)); expect(decoded.canvas).toEqual(canvas); expect(decoded.manifest).toEqual(p.manifest); });
    it('rejects corrupt bytes and unsupported node types', async () => { await expect(decodeScenePackage(new Uint8Array(30))).rejects.toThrow(); const p = fixture(); p.canvas = structuredClone(canvas); p.canvas.document.nodes[0].type = 'extension'; p.manifest = finalizeScenePackageManifest(p.manifest, p.canvas); await expect(decodeScenePackage(encodeScenePackage(p))).rejects.toThrow(); });
    it('rejects unportable content and invalid views', async () => { const p = fixture(); p.canvas = structuredClone(canvas); p.canvas.nodeData.n.url = 'file:///private/key'; p.manifest = finalizeScenePackageManifest(p.manifest, p.canvas); await expect(decodeScenePackage(encodeScenePackage(p))).rejects.toThrow(); });
});
it('rejects traversal, absolute, case conflicts, symlink metadata and CRC corruption', async () => {
    const p = fixture();
    p.manifest = finalizeScenePackageManifest(p.manifest, p.canvas);
    const original = Buffer.from(encodeScenePackage(p));
    for (const replacement of ['../evil.json', '/evilxx.json', 'MANIFEST.JSON']) {
        const bytes = Buffer.from(original);
        const where = bytes.indexOf(Buffer.from('manifest.json'));
        bytes.write(replacement.padEnd(13, 'x').slice(0, 13), where);
        await expect(decodeScenePackage(bytes)).rejects.toThrow();
    }
    const symlink = Buffer.from(original);
    const central = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    symlink.writeUInt32LE(0xa0000000, central + 38);
    await expect(decodeScenePackage(symlink)).rejects.toThrow();
    const corrupt = Buffer.from(original);
    corrupt[50] ^= 1;
    await expect(decodeScenePackage(corrupt)).rejects.toThrow();
});
it('rejects hash drift, missing edge targets and arbitrary media field bypasses', async () => {
    for (const mutate of [(p: any) => p.manifest.contentHash = '0'.repeat(64), (p: any) => p.canvas.document.edges.push({ id: 'e', source: 'n', target: 'absent', data: {} }), (p: any) => p.canvas.nodeData.n.mediaContent = { storageKey: 'secret' }]) {
        const p = fixture();
        p.canvas = structuredClone(canvas);
        p.manifest = finalizeScenePackageManifest(p.manifest, p.canvas);
        mutate(p);
        await expect(decodeScenePackage(encodeScenePackage(p))).rejects.toThrow();
    }
});
import { deflateRawSync } from 'node:zlib';
it('accepts bounded deflate entries and rejects declared inflation overflow', async () => {
    const p = fixture();
    p.manifest = finalizeScenePackageManifest(p.manifest, p.canvas);
    const original = Buffer.from(encodeScenePackage(p));
    const chunks: Buffer[] = [], central: Buffer[] = [];
    let at = 0, offset = 0;
    while (original.readUInt32LE(at) === 0x04034b50) {
        const nl = original.readUInt16LE(at + 26), length = original.readUInt32LE(at + 18), header = Buffer.from(original.subarray(at, at + 30 + nl)), body = deflateRawSync(original.subarray(at + 30 + nl, at + 30 + nl + length));
        header.writeUInt16LE(8, 8);
        header.writeUInt32LE(body.length, 18);
        chunks.push(header, body);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50);
        c.writeUInt16LE(20, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(header.readUInt16LE(6), 8);
        c.writeUInt16LE(8, 10);
        c.writeUInt32LE(header.readUInt32LE(14), 16);
        c.writeUInt32LE(body.length, 20);
        c.writeUInt32LE(length, 24);
        c.writeUInt16LE(nl, 28);
        c.writeUInt32LE(offset, 42);
        central.push(c, header.subarray(30));
        offset += header.length + body.length;
        at += 30 + nl + length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(2, 8);
    end.writeUInt16LE(2, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    const bytes = Buffer.concat([...chunks, cd, end]);
    expect((await decodeScenePackage(bytes)).canvas).toEqual(canvas);
    const bomb = Buffer.from(bytes);
    bomb.writeUInt32LE(1, offset + 24);
    await expect(decodeScenePackage(bomb)).rejects.toThrow();
});
it('rejects hash-correct wrong primitive types and nested payload bypasses', async () => {
    const mutations = [(p: any) => p.canvas.nodeData.n.prompt = { embedded: 'value' }, (p: any) => p.canvas.document.nodes[0].width = { embedded: 'value' }, (p: any) => p.canvas.title = [], (p: any) => p.manifest.title = { nested: 1 }, (p: any) => p.canvas.revision = 'zero', (p: any) => p.canvas.updatedAt = { time: 1 }, (p: any) => p.canvas.document.nodes[0].zIndex = 'front'];
    for (const mutate of mutations) {
        const p = fixture();
        p.canvas = structuredClone(canvas);
        mutate(p);
        p.manifest = finalizeScenePackageManifest(p.manifest, p.canvas);
        await expect(decodeScenePackage(encodeScenePackage(p))).rejects.toThrow();
    }
});
it('rejects hash-correct invalid image bytes', async () => {
    const p: any = fixture(), bytes = Buffer.from('not a PNG'), sha256 = createHash('sha256').update(bytes).digest('hex');
    p.canvas = structuredClone(canvas);
    p.canvas.document.nodes[0].type = 'image';
    p.canvas.nodeData.n = { title: 'Image', outputAssetId: 'a' };
    p.canvas.assets = [{ id: 'a', title: 'Image', mediaKind: 'image', source: 'uploaded', status: 'ready', url: 'scene-media:a', createdAt: '2026-01-01T00:00:00.000Z', metadata: { width: 512, height: 512 } }];
    p.manifest.media = [{ assetId: 'a', path: `media/${sha256}.png`, size: bytes.length, sha256, mimeType: 'image/png' }];
    p.media.set('a', bytes);
    p.manifest = finalizeScenePackageManifest(p.manifest, p.canvas);
    await expect(decodeScenePackage(encodeScenePackage(p))).rejects.toThrow();
});
import { createHash } from 'node:crypto';
it('requires accurate inventory, scene hash and supported compatibility metadata', async () => {
    for (const mutate of [(p: any) => delete p.manifest.scene, (p: any) => p.manifest.inventory.nodes++, (p: any) => p.manifest.scene.sha256 = '0'.repeat(64), (p: any) => p.manifest.compatibility.minAppVersion = '9.0.0', (p: any) => p.manifest.compatibility.capabilities.push('remote.provider')]) {
        const p = fixture();
        p.manifest = finalizeScenePackageManifest(p.manifest, p.canvas);
        mutate(p);
        await expect(decodeScenePackage(encodeScenePackage(p))).rejects.toThrow();
    }
});
it('preflights the aggregate decoded-image budget before any PNG inflation', async () => {
    const p: any = fixture();
    p.canvas = structuredClone(canvas);
    const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) {
        c ^= x;
        for (let i = 0; i < 8; i++)
            c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    } return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type: string, body: Buffer) => { const b = Buffer.alloc(body.length + 12); b.writeUInt32BE(body.length); b.write(type, 4); body.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + body.length)), 8 + body.length); return b; };
    // Seventeen individually bounded ~32 MiB images exceed512MiB together.
    // IDAT is intentionally notinflatable: budget rejection must precede ALL inflation.
    for (let i = 0; i < 17; i++) {
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(4096);
        ihdr.writeUInt32BE(2047, 4);
        ihdr[8] = 8;
        ihdr[9] = 6;
        const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([i])), chunk('IEND', Buffer.alloc(0))]), sha256 = createHash('sha256').update(bytes).digest('hex'), assetId = `a${i}`;
        p.media.set(assetId, bytes);
        p.manifest.media.push({ assetId, path: `media/${sha256}.png`, sha256, size: bytes.length, mimeType: 'image/png' });
    }
    p.manifest = finalizeScenePackageManifest(p.manifest, p.canvas);
    pngInflations.count = 0;
    await expect(decodeScenePackage(encodeScenePackage(p))).rejects.toThrow();
    expect(pngInflations.count).toBe(0);
});
it('reports stable permanent safe errors for invalid, incompatible and integrity failures',async()=>{
 await expect(decodeScenePackage(new Uint8Array(1))).rejects.toMatchObject({code:'package-invalid',retryable:false,message:'Invalid scene package'});
 const p=fixture();p.manifest=finalizeScenePackageManifest(p.manifest,p.canvas);p.manifest.compatibility.minAppVersion='9.0.0';await expect(decodeScenePackage(encodeScenePackage(p))).rejects.toMatchObject({code:'package-incompatible',retryable:false});
 p.manifest=finalizeScenePackageManifest(p.manifest,p.canvas);p.manifest.contentHash='0'.repeat(64);await expect(decodeScenePackage(encodeScenePackage(p))).rejects.toMatchObject({code:'package-integrity',retryable:false});
});
