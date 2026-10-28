import type { DecodedScenePackage, ScenePackageManifest, ServerCanvas } from '@woohaa3/contracts';
export type ScenePackagePublishedMedia = {
    storageKey: string;
    url: string;
    size: number;
    mimeType: string;
};
/** Accept only a successfully decoded package. Receipt identity keeps the original digest. */
export function remapScenePackage(decoded: DecodedScenePackage, options: {
    canvasId: string;
    prefix?: string;
    media: Map<string, ScenePackagePublishedMedia>;
}): {
    canvas: ServerCanvas;
    manifest: ScenePackageManifest;
} {
    const { canvas, manifest } = structuredClone(decoded), prefix = options.prefix ?? options.canvasId;
    const nodeIds = new Map(canvas.document.nodes.map((n, i) => [n.id, `${prefix}-node-${i}`]));
    const assetIds = new Map(canvas.assets.map((a, i) => [a.id, `${prefix}-asset-${i}`]));
    const required = (map: Map<string, string>, id: string) => { const next = map.get(id); if (!next)
        throw new Error('Invalid scene package reference'); return next; };
    canvas.id = options.canvasId;
    canvas.revision = 0;
    canvas.document.nodes = canvas.document.nodes.map(n => ({ ...n, id: required(nodeIds, n.id) }));
    canvas.document.edges = canvas.document.edges.map((e, i) => ({ ...e, id: `${prefix}-edge-${i}`, source: required(nodeIds, e.source), target: required(nodeIds, e.target) }));
    canvas.nodeData = Object.fromEntries(Object.entries(canvas.nodeData).map(([id, d]) => [required(nodeIds, id), { ...d, ...(d.outputAssetId ? { outputAssetId: required(assetIds, d.outputAssetId) } : {}) }])) as ServerCanvas['nodeData'];
    canvas.assets = canvas.assets.map(a => { const published = options.media.get(a.id); if (!published)
        throw new Error('Missing staged scene media'); return { ...a, id: required(assetIds, a.id), ...(a.nodeId ? { nodeId: required(nodeIds, a.nodeId) } : {}), url: published.url, metadata: { ...a.metadata, storageKey: published.storageKey, checksum:decoded.manifest.media.find(m=>m.assetId===a.id)!.sha256, size: published.size, contentType: published.mimeType } }; });
    for (const key of ['overview200', 'overview300', 'distant'] as const)
        manifest.views[key] = manifest.views[key].map(id => required(nodeIds, id));
    manifest.media = manifest.media.map(m => ({ ...m, assetId: required(assetIds, m.assetId) }));
    return { canvas, manifest };
}
