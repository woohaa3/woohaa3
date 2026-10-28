import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateScenePackage } from './scene-package.mjs';
test('deterministic complete text and model datasets', () => { for (const kind of ['text', 'model3d']) {
    const a = generateScenePackage(kind), b = generateScenePackage(kind);
    assert.deepEqual(a, b);
    assert.equal(a.canvas.document.nodes.length, 3000);
    assert.equal(a.canvas.document.edges.length, 12000);
    assert.equal(a.manifest.views.overview300.length, 300);
    assert.equal(a.manifest.views.overview200.length, 200);
    assert.equal(a.manifest.views.distant.length, 200);
    assert.equal(a.canvas.document.nodes.filter(n => n.type === 'model3d').length, kind === 'model3d' ? 400 : 0);
} });
import { decodeScenePackage, encodeScenePackage } from '../../web/backend/src/scene-package/archive.ts';
test('image scene contains400 independently decodable512PNG and roundtrips', async () => { const p = generateScenePackage('image'); assert.equal(p.media.size, 400); assert.equal(new Set(p.manifest.media.map(m => m.sha256)).size, 400); for (const b of p.media.values()) {
    assert.equal(b.readUInt32BE(16), 512);
    assert.equal(b.readUInt32BE(20), 512);
} const decoded = await decodeScenePackage(encodeScenePackage(p)); assert.equal(decoded.media.size, 400); assert.equal(decoded.manifest.contentHash, p.manifest.contentHash); });
test('all400model scripts pass bounded static validator on import', async () => { const decoded = await decodeScenePackage(encodeScenePackage(generateScenePackage('model3d'))); assert.equal(decoded.canvas.document.nodes.filter(n => n.type === 'model3d').length, 400); });
import { createPng } from './media.mjs';
import { createHash } from 'node:crypto';
import { finalizeScenePackageManifest } from '../../web/backend/src/scene-package/archive.ts';
test('hash-correct damaged PNG and false dimensions fail import', async () => {
    const original = createPng({ size: 128, seed: 1 });
    for (const mode of ['crc', 'truncated', 'dimensions']) {
        const p = generateScenePackage('text'), node = p.canvas.document.nodes[0];
        node.type = 'image';
        p.canvas.nodeData[node.id] = { title: 'Image', outputAssetId: 'a' };
        const bytes = Buffer.from(mode === 'truncated' ? original.subarray(0, original.length - 4) : original);
        if (mode === 'crc')
            bytes[35] ^= 1;
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        p.media.set('a', bytes);
        p.manifest.media = [{ assetId: 'a', path: `media/${sha256}.png`, sha256, size: bytes.length, mimeType: 'image/png' }];
        p.canvas.assets = [{ id: 'a', title: 'Image', mediaKind: 'image', source: 'uploaded', status: 'ready', url: 'scene-media:a', createdAt: p.canvas.updatedAt, metadata: { width: mode === 'dimensions' ? 512 : 128, height: 128 } }];
        p.manifest = finalizeScenePackageManifest(p.manifest, p.canvas);
        await assert.rejects(decodeScenePackage(encodeScenePackage(p)));
    }
});

import { effectiveCanvasNodeSize } from '../../web/contracts/dist/index.js';
test('overview targets do not overlap at effective renderer card sizes', () => {
  for (const kind of ['text', 'model3d']) {
    const p = generateScenePackage(kind);
    for (const view of ['overview200', 'overview300', 'distant']) {
      const ids = new Set(p.manifest.views[view]);
      const rects = p.canvas.document.nodes.filter(n => ids.has(n.id)).map(n => ({...n.position,...effectiveCanvasNodeSize(n)}));
      for (let i=0;i<rects.length;i++) for (let j=i+1;j<rects.length;j++) {
        const a=rects[i],b=rects[j];
        assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y, `${kind}/${view} overlaps at ${i}/${j}`);
      }
    }
  }
});
