/** Page-scoped open content resolution. Only confirmed immutable assets enter the existing media pipeline. */
import { decodeMediaContentRef, type CanvasCommand, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import type { MediaContentContext, MediaContentKind, MediaContentProvider, MediaContentService, MediaContentSource, MediaContentState } from "../../extension-api/media-content.js";
const identity = (v: unknown): string => JSON.stringify(v);
export function createMediaContentService(options: {
  canvas(): ServerCanvas | null;
  subscribe(listener: () => void): () => void;
  writable(): boolean;
  submit(commands: CanvasCommand[], requestId: string): Promise<void>;
}): MediaContentService & { dispose(): void } {
  const providers = new Map<string, MediaContentProvider>();
  const states = new Map<string, MediaContentState>();
  const attempts = new Map<string, string>();
  const controllers = new Map<AbortController, { nodeId: string; current(): boolean }>();
  const receipts = new Map<string, Promise<StoredAsset | null>>();
  const requests = new Map<string, string>();
  const listeners = new Set<() => void>();
  let disposed = false, scheduled = false, generation = 0;
  const notify = () => { for (const listener of listeners) listener(); };
  const describe = (canvas: ServerCanvas, ref: import("@woohaa3/contracts").MediaContentRef, kind: MediaContentKind): MediaContentSource => {
    const decoded = decodeMediaContentRef(ref);
    if (!decoded.ok) throw Error(decoded.reason);
    const provider = providers.get(ref.providerId);
    if (!provider) throw Error(`provider-unavailable: ${ref.providerId}`);
    if (!provider.schemaVersions.includes(ref.schemaVersion)) throw Error(`provider-version-unsupported: ${ref.providerId}/${ref.schemaVersion}`);
    const source = provider.describe(canvas, decoded.value);
    if (source.mediaKind !== kind || !provider.mediaKinds.includes(kind)) throw Error("provider-media-kind-mismatch");
    if (!source.sourceIdentity || source.dependencyNodeIds.some(id => !canvas.document.nodes.some(n => n.id === id))) throw Error("provider-source-unavailable");
    return source;
  };
  const resolve: MediaContentService["resolve"] = async (nodeId, operation, requestId) => {
    if (disposed) throw Error("provider-scope-disposed");
    const canvas = options.canvas(), node = canvas?.document.nodes.find(n => n.id === nodeId);
    const ref = canvas?.nodeData[nodeId]?.mediaContent;
    if (!canvas || !node || !ref || (node.type !== "image" && node.type !== "video")) throw Error("provider-target-unavailable");
    const provider = providers.get(ref.providerId);
    const source = describe(canvas, ref, node.type);
    const key = identity([canvas.id, nodeId, operation, requestId]);
    const fingerprint = identity([node.type, source.sourceIdentity, ref]);
    const prior = requests.get(key);
    if (prior !== undefined && prior !== fingerprint) throw Error("provider-request-id-reused");
    requests.set(key, fingerprint);
    if (receipts.has(key)) return receipts.get(key)!;
    const controller = new AbortController();
    const current = () => {
      const next = options.canvas(), target = next?.document.nodes.find(n => n.id === nodeId);
      if (disposed || controller.signal.aborted || providers.get(ref.providerId) !== provider || next?.id !== canvas.id || target?.type !== node.type || identity(next.nodeData[nodeId]?.mediaContent) !== identity(ref)) return false;
      try { return describe(next, ref, node.type as MediaContentKind).sourceIdentity === source.sourceIdentity; } catch { return false; }
    };
    controllers.set(controller, { nodeId, current });
    const task = Promise.resolve().then(async () => {
      const context: MediaContentContext = { canvas, nodeId, ref: structuredClone(ref), source, signal: controller.signal, requestId };
      const result = await provider![operation](context);
      if (!current()) throw Error("provider-source-stale");
      if (!result && operation === "resolvePreview") return null;
      if (!result || result.mediaKind !== node.type || result.status !== "ready" || !result.id || !result.metadata?.storageKey) throw Error("provider-invalid-result");
      return structuredClone(result);
    }).finally(() => controllers.delete(controller));
    receipts.set(key, task);
    // Failed materializations can be retried with the same stable request, never cached as success.
    void task.catch(() => { if (receipts.get(key) === task) receipts.delete(key); });
    return task;
  };
  const reconcile = () => {
    scheduled = false;
    if (disposed) return;
    const canvas = options.canvas();
    const ids = new Set(canvas?.document.nodes.map(n => n.id));
    for (const [controller, request] of controllers) if (!request.current()) controller.abort();
    for (const id of states.keys()) if (!ids.has(id) || !canvas?.nodeData[id]?.mediaContent) { states.delete(id); attempts.delete(id); }
    for (const node of canvas?.document.nodes ?? []) {
      const ref = canvas!.nodeData[node.id]?.mediaContent;
      if (!ref || (node.type !== "image" && node.type !== "video")) continue;
      let source: MediaContentSource;
      try { source = describe(canvas!, ref, node.type); }
      catch (error) {
        states.set(node.id, { ...states.get(node.id), status: "unavailable", diagnostic: String(error) }); continue;
      }
      const fingerprint = identity([generation, ref, source.sourceIdentity]);
      if (attempts.get(node.id) === fingerprint || !options.writable()) continue;
      attempts.set(node.id, fingerprint);
      const old = states.get(node.id);
      states.set(node.id, { ...old, status: "pending", sourceIdentity: source.sourceIdentity });
      void (async () => {
        try {
          const preview = await resolve(node.id, "resolvePreview", `preview:${source.sourceIdentity}`);
          if (preview && !disposed && attempts.get(node.id) === fingerprint) { states.set(node.id, { status: "pending", asset: preview, sourceIdentity: source.sourceIdentity }); notify(); }
          const asset = await resolve(node.id, "materialize", `live:${source.sourceIdentity}`);
          const latest = options.canvas();
          if (!asset || disposed || latest?.id !== canvas!.id || attempts.get(node.id) !== fingerprint) return;
          // Authority rechecks every dependency and target in the same atomic command batch.
          const expectedNodeData = Object.fromEntries([...new Set([node.id, ...source.dependencyNodeIds])].map(id => [id, latest.nodeData[id] ?? null]));
          if (describe(latest, ref, node.type as MediaContentKind).sourceIdentity !== source.sourceIdentity) return;
          await options.submit([{ type: "nodeData.patch", nodeId: node.id, expectedNodeData,
            value: { outputAssetId: asset.id, status: "ready" } }, { type: "asset.upsert", asset }], `media-content:${node.id}:${crypto.randomUUID()}`);
          if (!disposed && attempts.get(node.id) === fingerprint) { states.set(node.id, { status: "ready", asset, sourceIdentity: source.sourceIdentity }); notify(); }
        } catch (error) {
          if (!disposed && attempts.get(node.id) === fingerprint) { states.set(node.id, { ...old, status: "failed", diagnostic: String(error), sourceIdentity: source.sourceIdentity }); notify(); }
        }
      })();
    }
    notify();
  };
  const schedule = () => { if (!scheduled && !disposed) { scheduled = true; queueMicrotask(reconcile); } };
  const unsubscribe = options.subscribe(schedule);
  const register: MediaContentService["register"] = provider => {
    if (disposed || providers.has(provider.providerId)) throw Error(`provider-id-conflict: ${provider.providerId}`);
    if (!provider.owner || (provider.providerId !== "asset" && !provider.providerId.startsWith(`${provider.owner}.`)) || !provider.schemaVersions.length || provider.schemaVersions.some(v => !Number.isSafeInteger(v) || v < 1) || !provider.mediaKinds.length || provider.mediaKinds.some(v => v !== "image" && v !== "video")) throw Error("provider-invalid-registration");
    providers.set(provider.providerId, provider); generation++; attempts.clear(); schedule();
    let active = true;
    return () => {
      if (!active) return; active = false;
      if (providers.get(provider.providerId) === provider) providers.delete(provider.providerId);
      // Invalidating all in-flight requests is safe and prevents released handles being published.
      for (const controller of controllers.keys()) controller.abort();
      generation++; receipts.clear(); attempts.clear(); provider.dispose?.(); schedule();
    };
  };
  const assetFor = (context: MediaContentContext): StoredAsset => {
    const asset = context.canvas.assets.find(a => a.id === context.ref.payload.assetId);
    if (!asset || asset.status !== "ready") throw Error("asset-unavailable");
    return asset;
  };
  register({ providerId: "asset", owner: "core", schemaVersions: [1], mediaKinds: ["image", "video"],
    describe(canvas, ref) {
      if (typeof ref.payload.assetId !== "string" || Object.keys(ref.payload).some(k => k !== "assetId")) throw Error("asset-payload-invalid");
      const asset = canvas.assets.find(a => a.id === ref.payload.assetId);
      if (!asset || (asset.mediaKind !== "image" && asset.mediaKind !== "video")) throw Error("asset-unavailable");
      return { mediaKind: asset.mediaKind, sourceIdentity: identity([asset.id, asset.metadata?.checksum, asset.metadata?.storageKey]), dependencyNodeIds: [] };
    }, resolvePreview: async c => assetFor(c), materialize: async c => assetFor(c), snapshot: async c => assetFor(c) });
  return {
    register, describe, resolve,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    state: id => states.get(id),
    retry(id) { attempts.delete(id); schedule(); },
    async freeze(canvas, nodeIds, requestId) {
      const frozen = structuredClone(canvas);
      const identities = new Map(nodeIds.filter(id => canvas.nodeData[id]?.mediaContent).map(id => {
        const node = canvas.document.nodes.find(n => n.id === id)!;
        return [id, describe(canvas, canvas.nodeData[id].mediaContent!, node.type as MediaContentKind).sourceIdentity];
      }));
      const snapshots = await Promise.all(nodeIds.filter(id => canvas.nodeData[id]?.mediaContent).map(async id => {
        const asset = await resolve(id, "snapshot", requestId);
        if (!asset) throw Error("provider-snapshot-unavailable");
        return { id, asset };
      }));
      const current = options.canvas();
      if (!current || current.id !== canvas.id) throw Error("provider-copy-source-stale");
      for (const [id, sourceIdentity] of identities) {
        const node = current.document.nodes.find(n => n.id === id);
        const ref = current.nodeData[id]?.mediaContent;
        if (!node || !ref || identity(ref) !== identity(canvas.nodeData[id].mediaContent) || describe(current, ref, node.type as MediaContentKind).sourceIdentity !== sourceIdentity) throw Error("provider-copy-source-stale");
      }
      for (const { id, asset } of snapshots) {
        delete frozen.nodeData[id].mediaContent;
        frozen.nodeData[id].outputAssetId = asset.id;
        frozen.assets = [...frozen.assets.filter(a => a.id !== asset.id), asset];
      }
      return frozen;
    },
    dispose() { if (disposed) return; disposed = true; unsubscribe(); for (const c of controllers.keys()) c.abort(); for (const p of providers.values()) p.dispose?.(); providers.clear(); receipts.clear(); requests.clear(); states.clear(); attempts.clear(); listeners.clear(); },
  };
}
