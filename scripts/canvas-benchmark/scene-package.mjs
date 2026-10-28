import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { effectiveCanvasNodeSize } from '../../web/contracts/dist/index.js';
import { createPng } from './media.mjs';
import { encodeScenePackage, finalizeScenePackageManifest } from '../../web/backend/src/scene-package/archive.ts';
/** Fixed 3,000-node dataset; 200 origin media + 100 adjacent text, 200 distant media. */
export function generateScenePackage(kind = 'text') {
    if (!['text', 'image', 'model3d'].includes(kind))
        throw new Error('Unknown dataset kind');
    const timestamp = '2026-01-01T00:00:00.000Z', nodes = [], edges = [], nodeData = {}, assets = [], media = new Map(), mediaEntries = [];
    const overview200 = [], overview300 = [], distant = [];
    const card = effectiveCanvasNodeSize({type:kind,width:180,height:130});
    const strideX = card.width + 20, strideY = card.height + 20;
    for (let i = 0; i < 3000; i++) {
        const id = `scene-${kind}-${String(i).padStart(4, '0')}`, origin = i < 200, far = i >= 200 && i < 400, extra = i >= 400 && i < 500;
        const local = origin ? i : far ? i - 200 : extra ? i - 200 : i - 500;
        const position = origin || extra ? { x: (local % 20) * strideX, y: Math.floor(local / 20) * strideY } : far ? { x: 20000 + (local % 20) * strideX, y: Math.floor(local / 20) * strideY } : { x: 40000 + (local % 100) * strideX, y: 20000 + Math.floor(local / 100) * strideY };
        const type = i < 400 ? kind : 'text';
        nodes.push({ id, type, position, width: card.width, height: card.height });
        nodeData[id] = { title: `${kind} ${i}`, prompt: `Deterministic scene node ${i}` };
        if (origin) {
            overview200.push(id);
            overview300.push(id);
        }
        if (extra)
            overview300.push(id);
        if (far)
            distant.push(id);
        if (type === 'model3d')
            nodeData[id] = { title: `Model ${i}`, modelScriptLanguage: 'javascript', modelScriptVersion: 'woohaa-model-js-v2', modelScript: `scene.box({id:"box",size:[${1 + i / 1000},1,1],color:"#${(0x447799 + i * 137).toString(16).padStart(6, '0')}"});scene.sphere({id:"sphere",radius:${0.3 + i / 10000},position:[0,1,0]});` };
        if (type === 'image') {
            const bytes = createPng({ size: 512, seed: i + 42 }), sha256 = createHash('sha256').update(bytes).digest('hex'), assetId = `image-${i}`;
            media.set(assetId, bytes);
            mediaEntries.push({ assetId, path: `media/${sha256}.png`, sha256, size: bytes.length, mimeType: 'image/png' });
            assets.push({ id: assetId, nodeId: id, title: `Image ${i}`, mediaKind: 'image', source: 'uploaded', status: 'ready', url: `scene-media:${assetId}`, createdAt: timestamp, metadata: { width: 512, height: 512 } });
            nodeData[id] = { title: `Image ${i}`, outputAssetId: assetId };
        }
    }
    for (let i = 0; i < nodes.length; i++)
        for (let j = 1; j <= 4; j++)
            edges.push({ id: `edge-${i}-${j}`, source: nodes[i].id, target: nodes[(i + j) % 3000].id, sourceHandle: null, targetHandle: null, data: {} });
    const canvas = { id: `scene-${kind}`, title: `Large canvas · ${kind}`, revision: 0, document: { schemaVersion: 'asset-canvas-v1', nodes, edges, updatedAt: timestamp }, nodeData, assets, jobs: [], updatedAt: timestamp };
    const manifest = { format: 'woohaa-scene', version: 1, datasetId: `large-canvas-${kind}-v1`, contentHash: '', recipeVersion: 1, kind, title: canvas.title, views: { overview200, overview300, distant }, media: mediaEntries };
    return { manifest: finalizeScenePackageManifest(manifest, canvas), canvas, media };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const kind = process.argv[2] ?? 'text', output = process.argv[3] ?? `${kind}.woohaa-scene`;
    writeFileSync(output, encodeScenePackage(generateScenePackage(kind)));
    console.log(output);
}
