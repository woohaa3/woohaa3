import { createHash } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';
import type { DecodedScenePackage, ScenePackageManifest, ServerCanvas } from '@woohaa3/contracts';
import { SCENE_PACKAGE_LIMITS as L, validateScenePackageModel } from '@woohaa3/contracts';
const hash = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export class ScenePackageError extends Error { readonly retryable=false;readonly code:string;constructor(code:string='package-invalid'){super('Invalid scene package');this.code=code;this.name='ScenePackageError';}}
const fail = (code='package-invalid'): never => { throw new ScenePackageError(code); };
function keys(value: any, allowed: string[]): void {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
        fail();
}
function canonical(v: unknown): string {
    if (Array.isArray(v))
        return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object')
        return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
    return JSON.stringify(v);
}
export function computeScenePackageContentHash(manifest: ScenePackageManifest, canvas: ServerCanvas): string { const { contentHash: _, ...identity } = manifest; return hash(canonical({ manifest: identity, canvas })); }
function crc32(b: Uint8Array): number {
    let c = 0xffffffff;
    for (const x of b) {
        c ^= x;
        for (let n = 0; n < 8; n++)
            c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
}
function text(v: unknown, max = 4096): boolean { return typeof v === 'string' && v.length <= max; }
function id(v: unknown): boolean { return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(v) && !['constructor', 'prototype', '__proto__'].includes(v); }
function date(v: unknown): boolean { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)); }
function supportedVersion(v: unknown): boolean {
    if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v))
        return false;
    const parts = v.split('.').map(Number), current = [0, 1, 6];
    for (let i = 0; i < 3; i++) {
        if (parts[i]! < current[i]!)
            return true;
        if (parts[i]! > current[i]!)
            return false;
    }
    return true;
}
function optionalText(v: unknown, max = 4096): boolean { return v === undefined || text(v, max); }
function number(v: unknown, min: number, max: number): boolean { return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max; }
/** V1 accepts metadata-free, noninterlaced RGBA8 PNGs only, with bounded inflation. */
type PreparedPng = {
    width: number;
    height: number;
    decodedBytes: number;
    compressed: Buffer;
};
function preparePng(bytes: Uint8Array): PreparedPng {
    const b = Buffer.from(bytes);
    if (b.length < 45 || b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
        fail();
    let at = 8, width = 0, height = 0, ended = false, idatEnded = false;
    const data: Buffer[] = [];
    while (at < b.length) {
        if (at + 12 > b.length)
            fail();
        const length = b.readUInt32BE(at), type = b.subarray(at + 4, at + 8).toString('ascii'), end = at + 12 + length;
        if (end > b.length || crc32(b.subarray(at + 4, at + 8 + length)) !== b.readUInt32BE(at + 8 + length))
            fail();
        if (type === 'IHDR') {
            if (at !== 8 || length !== 13)
                fail();
            width = b.readUInt32BE(at + 8);
            height = b.readUInt32BE(at + 12);
            if (!width || !height || width > 8192 || height > 8192 || height * (1 + width * 4) > 64 * 1024 * 1024 || b[at + 16] !== 8 || b[at + 17] !== 6 || b[at + 18] !== 0 || b[at + 19] !== 0 || b[at + 20] !== 0)
                fail();
        }
        else if (type === 'IDAT') {
            if (!width || idatEnded)
                fail();
            data.push(b.subarray(at + 8, at + 8 + length));
        }
        else if (type === 'IEND') {
            if (length || !data.length || end !== b.length)
                fail();
            ended = true;
            idatEnded = true;
        }
        else
            fail();
        at = end;
    }
    if (!ended)
        fail();
    return { width, height, decodedBytes: height * (1 + width * 4), compressed: Buffer.concat(data) };
}
function validatePng(png: PreparedPng): void {
    const { width, height, decodedBytes: expected, compressed } = png;
    const inflated = inflateSync(compressed, { maxOutputLength: expected, info: true }) as unknown as {
        buffer: Buffer;
        engine: {
            bytesWritten: number;
        };
    };
    if (inflated.buffer.length !== expected || inflated.engine.bytesWritten !== compressed.length)
        fail();
    for (let y = 0; y < height; y++)
        if (inflated.buffer[y * (1 + width * 4)]! > 4)
            fail();
}
export function finalizeScenePackageManifest(manifest: Omit<ScenePackageManifest, 'contentHash' | 'scene' | 'inventory' | 'compatibility'> & Partial<Pick<ScenePackageManifest, 'contentHash' | 'scene' | 'inventory' | 'compatibility'>>, canvas: ServerCanvas): ScenePackageManifest {
    const scene = Buffer.from(JSON.stringify(canvas));
    const result: ScenePackageManifest = { ...manifest, scene: { sha256: hash(scene), size: scene.length }, inventory: { nodes: canvas.document.nodes.length, edges: canvas.document.edges.length, media: manifest.media.length }, compatibility: { minAppVersion: '0.1.6', capabilities: [...new Set(canvas.document.nodes.map(n => `builtin.${n.type}`))].sort() }, contentHash: '' };
    result.contentHash = computeScenePackageContentHash(result, canvas);
    return result;
}
function pathOK(p: string): boolean { return /^(manifest\.json|scene\.json|media\/[a-f0-9]{64}\.[a-z0-9]+)$/.test(p); }
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
    const b = Buffer.from(bytes);
    if (b.length > L.compressedBytes || b.length < 22)
        fail();
    let end = b.length - 22;
    while (end >= Math.max(0, b.length - 65557) && b.readUInt32LE(end) !== 0x06054b50)
        end--;
    if (end < 0 || b.readUInt32LE(end) !== 0x06054b50)
        fail();
    const count = b.readUInt16LE(end + 10), start = b.readUInt32LE(end + 16), size = b.readUInt32LE(end + 12);
    if (!count || count > L.entries || b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6) || b.readUInt16LE(end + 8) !== count || start + size !== end || end + 22 + b.readUInt16LE(end + 20) !== b.length)
        fail();
    const entries = new Map<string, Uint8Array>();
    const names = new Set<string>();
    const ranges: [
        number,
        number
    ][] = [];
    let cursor = start, total = 0;
    for (let i = 0; i < count; i++) {
        if (cursor + 46 > end || b.readUInt32LE(cursor) !== 0x02014b50)
            fail();
        const flags = b.readUInt16LE(cursor + 8), method = b.readUInt16LE(cursor + 10), crc = b.readUInt32LE(cursor + 16), compressed = b.readUInt32LE(cursor + 20), unpacked = b.readUInt32LE(cursor + 24), nl = b.readUInt16LE(cursor + 28), el = b.readUInt16LE(cursor + 30), cl = b.readUInt16LE(cursor + 32), offset = b.readUInt32LE(cursor + 42);
        if (cursor + 46 + nl + el + cl > end)
            fail();
        const name = b.subarray(cursor + 46, cursor + 46 + nl).toString('utf8');
        if (!pathOK(name) || names.has(name.toLowerCase()) || (flags & ~0x808) !== 0 || ![0, 8].includes(method) || (b.readUInt32LE(cursor + 38) >>> 16 & 0xf000) === 0xa000 || b.readUInt16LE(cursor + 34))
            fail();
        names.add(name.toLowerCase());
        total += unpacked;
        if (total > L.unpackedBytes || offset + 30 > start || b.readUInt32LE(offset) !== 0x04034b50 || b.readUInt16LE(offset + 6) !== flags || b.readUInt16LE(offset + 8) !== method)
            fail();
        const ln = b.readUInt16LE(offset + 26), le = b.readUInt16LE(offset + 28), dataStart = offset + 30 + ln + le, dataEnd = dataStart + compressed;
        if (dataEnd > start || b.subarray(offset + 30, offset + 30 + ln).toString('utf8') !== name || ranges.some(([a, z]) => offset < z && dataEnd > a))
            fail();
        let recordEnd = dataEnd;
        if (flags & 8) {
            const signature = recordEnd + 4 <= start && b.readUInt32LE(recordEnd) === 0x08074b50;
            if (signature)
                recordEnd += 4;
            if (recordEnd + 12 > start || b.readUInt32LE(recordEnd) !== crc || b.readUInt32LE(recordEnd + 4) !== compressed || b.readUInt32LE(recordEnd + 8) !== unpacked)
                fail();
            recordEnd += 12;
        }
        else if (b.readUInt32LE(offset + 14) !== crc || b.readUInt32LE(offset + 18) !== compressed || b.readUInt32LE(offset + 22) !== unpacked)
            fail();
        ranges.push([offset, recordEnd]);
        const raw = b.subarray(dataStart, dataEnd), out = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, unpacked) });
        if (out.length !== unpacked || crc32(out) !== crc)
            fail('package-integrity');
        entries.set(name, new Uint8Array(out));
        cursor += 46 + nl + el + cl;
    }
    if (cursor !== end)
        fail();
    ranges.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    for (const [a, z] of ranges) {
        if (a !== covered)
            fail();
        covered = z;
    }
    if (covered !== start)
        fail();
    return entries;
}
function validate(manifest: any, canvas: any, entries: Map<string, Uint8Array>): DecodedScenePackage {
 if(manifest?.format!=='woohaa-scene'||manifest?.version!==1)fail('package-incompatible');
    if (manifest?.format !== 'woohaa-scene' || manifest.version !== 1 || !['text', 'image', 'model3d'].includes(manifest.kind) || !Number.isSafeInteger(manifest.recipeVersion) || manifest.recipeVersion < 1 || typeof manifest.datasetId !== 'string' || !/^[\w.-]{1,120}$/.test(manifest.datasetId) || !Array.isArray(manifest.media) || canvas?.document?.schemaVersion !== 'asset-canvas-v1' || !Array.isArray(canvas.document.nodes) || !Array.isArray(canvas.document.edges) || !Array.isArray(canvas.assets) || !Array.isArray(canvas.jobs) || canvas.jobs.length || !canvas.nodeData)
        fail();
    keys(manifest, ['format', 'version', 'datasetId', 'contentHash', 'recipeVersion', 'kind', 'title', 'scene', 'inventory', 'compatibility', 'views', 'media']);
    keys(manifest.views, ['overview200', 'overview300', 'distant']);
    keys(canvas, ['id', 'title', 'revision', 'document', 'nodeData', 'assets', 'jobs', 'updatedAt']);
    keys(canvas.document, ['schemaVersion', 'nodes', 'edges', 'updatedAt']);
    if (!id(canvas.id) || !text(canvas.title) || !Number.isSafeInteger(canvas.revision) || canvas.revision < 0 || !date(canvas.updatedAt) || !date(canvas.document.updatedAt) || !text(manifest.title) || !text(manifest.contentHash, 64) || !/^[a-f0-9]{64}$/.test(manifest.contentHash))
        fail();
    keys(canvas.nodeData, Object.keys(canvas.nodeData));
    keys(manifest.scene, ['sha256', 'size']);
    keys(manifest.inventory, ['nodes', 'edges', 'media']);
    keys(manifest.compatibility, ['minAppVersion', 'capabilities']);
    const expectedScene = entries.get('scene.json')!;
    if (manifest.scene.sha256 !== hash(expectedScene) || manifest.scene.size !== expectedScene.length || manifest.inventory.nodes !== canvas.document.nodes.length || manifest.inventory.edges !== canvas.document.edges.length || manifest.inventory.media !== manifest.media.length)
        fail();
    if(!supportedVersion(manifest.compatibility.minAppVersion)||!Array.isArray(manifest.compatibility.capabilities))fail('package-incompatible');
    const requiredCapabilities = [...new Set(canvas.document.nodes.map((n: any) => `builtin.${n.type}`))].sort();
    if (JSON.stringify(manifest.compatibility.capabilities) !== JSON.stringify(requiredCapabilities))
        fail('package-incompatible');
    const nodes = canvas.document.nodes, edges = canvas.document.edges;
    if (nodes.length > L.nodes || edges.length > L.edges)
        fail();
    const ids = new Set<string>();
    for (const n of nodes) {
        keys(n, ['id', 'type', 'position', 'width', 'height', 'zIndex']);
        keys(n.position, ['x', 'y']);
        if (!id(n.id) || ids.has(n.id) || !number(n.position.x, -1e9, 1e9) || !number(n.position.y, -1e9, 1e9) || (n.width !== undefined && !number(n.width, 0.001, 1e6)) || (n.height !== undefined && !number(n.height, 0.001, 1e6)) || (n.zIndex !== undefined && !number(n.zIndex, -1e9, 1e9)) || !['text', 'image', 'model3d'].includes(n.type) || !Number.isFinite(n.position?.x) || !Number.isFinite(n.position?.y) || n.parentId)
            fail();
        ids.add(n.id);
    }
    const edgeIds = new Set<string>();
    for (const e of edges) {
        keys(e, ['id', 'source', 'target', 'sourceHandle', 'targetHandle', 'data']);
        keys(e.data, []);
        if (!id(e.id) || edgeIds.has(e.id) || !(e.sourceHandle === undefined || e.sourceHandle === null || text(e.sourceHandle)) || !(e.targetHandle === undefined || e.targetHandle === null || text(e.targetHandle)) || !ids.has(e.source) || !ids.has(e.target))
            fail();
        edgeIds.add(e.id);
    }
    for (const id of Object.keys(canvas.nodeData))
        if (!ids.has(id))
            fail();
    for (const key of ['overview200', 'overview300', 'distant']) {
        const view = manifest.views?.[key];
        if (!Array.isArray(view) || new Set(view).size !== view.length || view.some((id: unknown) => !ids.has(id as string)))
            fail();
    }
    const media = new Map<string, Uint8Array>(), paths = new Set<string>(), preparedImages = new Map<string, PreparedPng>();
    let decodedImageBytes = 0;
    for (const m of manifest.media) {
        keys(m, ['assetId', 'path', 'sha256', 'size', 'mimeType']);
        if (!id(m.assetId) || media.has(m.assetId) || m.mimeType !== 'image/png' || typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256) || paths.has(m.path) || !pathOK(m.path) || m.path !== `media/${m.sha256}.${m.mimeType === 'image/png' ? 'png' : 'invalid'}` || !Number.isSafeInteger(m.size) || m.size < 0)
            fail();
        const bytes = entries.get(m.path);
        if (!bytes || bytes.length !== m.size || hash(bytes) !== m.sha256)
            fail('package-integrity');
        const prepared = preparePng(bytes!);
        decodedImageBytes += prepared.decodedBytes;
        if (decodedImageBytes > L.decodedImageBytes)
            fail();
        preparedImages.set(m.assetId, prepared);
        paths.add(m.path);
        media.set(m.assetId, bytes!);
    }
    if (entries.size !== paths.size + 2)
        fail();
    for (const prepared of preparedImages.values())
        validatePng(prepared);
    const assetIds = new Set<string>();
    for (const a of canvas.assets) {
        keys(a, ['id', 'nodeId', 'title', 'mediaKind', 'source', 'status', 'url', 'createdAt', 'metadata']);
        if (a.metadata)
            keys(a.metadata, ['width', 'height']);
        if (!id(a.id) || !text(a.title) || !date(a.createdAt) || (a.nodeId !== undefined && !id(a.nodeId)) || assetIds.has(a.id) || !media.has(a.id) || a.url !== `scene-media:${a.id}` || a.mediaKind !== 'image' || a.status !== 'ready' || a.source !== 'uploaded' || (a.nodeId && !ids.has(a.nodeId)))
            fail();
        const dimensions = preparedImages.get(a.id)!;
        if (a.metadata && ((a.metadata.width !== undefined && a.metadata.width !== dimensions.width) || (a.metadata.height !== undefined && a.metadata.height !== dimensions.height)))
            fail();
        assetIds.add(a.id);
    }
    if (assetIds.size !== media.size)
        fail();
    function portable(v: unknown, key = ''): void {
        if (typeof v === 'string') {
            if (/^(https?:|file:|blob:|data:|\/|[a-z]:[\\/])/i.test(v) || v.includes('\\') || /token|password|credential|storageKey|apiKey|secret/i.test(key))
                fail();
            if (v.startsWith('scene-media:') && !assetIds.has(v.slice(12)))
                fail();
        }
        else if (Array.isArray(v))
            v.forEach(x => portable(x, key));
        else if (v && typeof v === 'object')
            for (const [k, x] of Object.entries(v))
                portable(x, k);
    }
    portable(canvas);
    for (const n of nodes) {
        const d = canvas.nodeData[n.id];
        if (!d)
            fail();
        keys(d, n.type === 'model3d' ? ['title', 'modelScript', 'modelScriptLanguage', 'modelScriptVersion'] : n.type === 'image' ? ['title', 'outputAssetId'] : ['title', 'prompt']);
        if (!optionalText(d.title) || !optionalText(d.prompt, 1024 * 1024) || !optionalText(d.modelScript, 1024 * 1024))
            fail();
        if (n.type === 'image' && (!id(d.outputAssetId) || !assetIds.has(d.outputAssetId)))
            fail();
        if (n.type === 'model3d' && (d.modelScriptLanguage !== 'javascript' || d.modelScriptVersion !== 'woohaa-model-js-v2' || typeof d.modelScript !== 'string' || !validateScenePackageModel(d.modelScript, d.modelScriptVersion).ok))
            fail();
    }
    if (computeScenePackageContentHash(manifest, canvas) !== manifest.contentHash)
        fail('package-integrity');
    return { manifest, canvas, media };
}
export async function decodeScenePackage(bytes: Uint8Array): Promise<DecodedScenePackage> {
    try {
    const entries = readZip(bytes);
    const parse = (name: string) => {
        const data = entries.get(name);
        if (!data)
            fail();
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    };
    return validate(parse('manifest.json'), parse('scene.json'), entries);
    }catch(error){if(error instanceof ScenePackageError)throw error;throw new ScenePackageError();}
}
export function encodeScenePackage(p: DecodedScenePackage): Uint8Array {
    const input = new Map<string, Uint8Array>([['manifest.json', Buffer.from(JSON.stringify(p.manifest))], ['scene.json', Buffer.from(JSON.stringify(p.canvas))]]);
    for (const m of p.manifest.media) {
        const data = p.media.get(m.assetId);
        if (!data)
            fail();
        input.set(m.path, data!);
    }
    return encodeZipEntries(input);
}
/** Deterministic stored ZIP for build-side delivery collections; no ZIP64. */
export function encodeZipEntries(input:Map<string,Uint8Array>):Uint8Array {
    if(!input.size||input.size>65535)throw new Error('ZIP entry count unsupported');
    const chunks: Buffer[] = [], central: Buffer[] = [];
    let offset = 0;
    for (const [name, data] of input) {
        const n = Buffer.from(name), b = Buffer.from(data), crc = crc32(b), h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0x800, 6);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(b.length, 18);
        h.writeUInt32LE(b.length, 22);
        h.writeUInt16LE(n.length, 26);
        chunks.push(h, n, b);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50);
        c.writeUInt16LE(20, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(0x800, 8);
        c.writeUInt32LE(crc, 16);
        c.writeUInt32LE(b.length, 20);
        c.writeUInt32LE(b.length, 24);
        c.writeUInt16LE(n.length, 28);
        c.writeUInt32LE(offset, 42);
        central.push(c, n);
        offset += h.length + n.length + b.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(input.size, 8);
    end.writeUInt16LE(input.size, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, cd, end]);
}
