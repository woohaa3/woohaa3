/** Page-scoped open content resolution. Only confirmed immutable assets enter the existing media pipeline. */
import { decodeMediaContentRef, randomId, type CanvasCommand, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import type { MediaContentContext, MediaContentKind, MediaContentProvider, MediaContentService, MediaContentSource, MediaContentState } from "../../extension-api/media-content.js";
const identity = (v: unknown): string => JSON.stringify(v);
export function createMediaContentService(options: {
  canvas(): ServerCanvas | null;
  subscribe(listener: () => void): () => void;
  writable(): boolean;
  submit(commands: CanvasCommand[], requestId: string): Promise<void>;
}): MediaContentService & { dispose(): void } {
  const providers = new Map<string, MediaContentProvider>();
  const providerSubscriptions = new Map<string, () => void>();
  const states = new Map<string, MediaContentState>();
  const attempts = new Map<string, string>();
  /** 已 ready 但规范 outputAssetId 尚未写回时的去重键（nodeId → sourceIdentity:assetId）。 */
  const repairs = new Map<string, string>();
  /** 写回失败后的有界重试（nodeId → 计时器/连续失败次数）。 */
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryFailures = new Map<string, number>();
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
  const clearRetry = (nodeId: string): void => {
    const timer = retryTimers.get(nodeId);
    if (timer !== undefined) clearTimeout(timer);
    retryTimers.delete(nodeId);
    retryFailures.delete(nodeId);
  };

  /** 写回失败后按有界退避重试；宿主重连结束后不必等到下一次画布编辑。 */
  const scheduleRetry = (nodeId: string): void => {
    if (disposed || retryTimers.has(nodeId)) return;
    const attempt = retryFailures.get(nodeId) ?? 0;
    retryFailures.set(nodeId, attempt + 1);
    const delay = Math.min(1_000 * 2 ** Math.min(attempt, 3), 8_000);
    const timer = setTimeout(() => {
      retryTimers.delete(nodeId);
      schedule();
    }, delay);
    retryTimers.set(nodeId, timer);
  };

  /**
   * 补写已 ready 但未落到 canonical 的结果。
   *
   * provider 在上传成功后先发布 ready 状态，随后的 `nodeData.patch` 可能因为同时发生的
   * 画布写入（镜头冻结、任务投影）或宿主短暂重连而失败。失败后 `attempts` 会阻止同一
   * 内容身份再次物化，而 provider 也不会再发通知，于是镜头卡片一直显示旧图。这里在每次
   * reconcile 时对比 ready asset 与 `outputAssetId`，缺失就补一次；按内容身份去重，
   * 失败后允许下一轮重新提交。
   */
  const repairWriteBack = (
    canvas: ServerCanvas,
    nodeId: string,
    source: MediaContentSource,
    asset: StoredAsset
  ): void => {
    const key = `${source.sourceIdentity}:${asset.id}`;
    if (repairs.get(nodeId) === key) return;
    repairs.set(nodeId, key);
    const expectedNodeData = Object.fromEntries([...new Set([nodeId, ...source.dependencyNodeIds])].map(id => [id, canvas.nodeData[id] ?? null]));
    void options.submit([{ type: "nodeData.patch", nodeId, expectedNodeData,
      value: { outputAssetId: asset.id, status: "ready" } }], `media-content-repair:${nodeId}:${randomId()}`).then(
      () => {
        if (repairs.get(nodeId) === key) repairs.delete(nodeId);
        clearRetry(nodeId);
      },
      () => {
        if (repairs.get(nodeId) === key) repairs.delete(nodeId);
        scheduleRetry(nodeId);
      }
    );
  };

  const reconcile = () => {
    scheduled = false;
    if (disposed) return;
    const canvas = options.canvas();
    const ids = new Set(canvas?.document.nodes.map(n => n.id));
    for (const [controller, request] of controllers) if (!request.current()) controller.abort();
    for (const id of states.keys()) if (!ids.has(id) || !canvas?.nodeData[id]?.mediaContent) { states.delete(id); attempts.delete(id); repairs.delete(id); clearRetry(id); }
    for (const node of canvas?.document.nodes ?? []) {
      const ref = canvas!.nodeData[node.id]?.mediaContent;
      if (!ref || (node.type !== "image" && node.type !== "video")) continue;
      let source: MediaContentSource;
      try { source = describe(canvas!, ref, node.type); }
      catch (error) {
        states.set(node.id, { ...states.get(node.id), status: "unavailable", diagnostic: String(error) }); continue;
      }
      const writable = options.writable();
      // 已 ready 但规范 outputAssetId 仍是旧图：补写结果。若只依赖物化 promise 的
      // 一次写回，任何并发写入/短暂重连都会让镜头卡片永久停在旧内容。
      const current = states.get(node.id);
      if (writable && current?.status === "ready" && current.asset
        && current.sourceIdentity === source.sourceIdentity
        && canvas!.nodeData[node.id]?.outputAssetId !== current.asset.id) {
        repairWriteBack(canvas!, node.id, source, current.asset);
      }
      const fingerprint = identity([generation, ref, source.sourceIdentity, writable]);
      if (attempts.get(node.id) === fingerprint) continue;
      attempts.set(node.id, fingerprint);
      const old = states.get(node.id);
      states.set(node.id, { ...old, status: "pending", sourceIdentity: source.sourceIdentity });
      void (async () => {
        try {
          const preview = await resolve(node.id, "resolvePreview", `preview:${source.sourceIdentity}`);
          if (preview && !disposed && attempts.get(node.id) === fingerprint) { states.set(node.id, { status: "pending", asset: preview, sourceIdentity: source.sourceIdentity }); notify(); }
          if (!writable) {
            if (!disposed && attempts.get(node.id) === fingerprint) {
              states.set(node.id, preview ? { status: "ready", asset: preview, sourceIdentity: source.sourceIdentity }
                : { status: "unavailable", diagnostic: "当前版本尚无可读取的媒体缓存", sourceIdentity: source.sourceIdentity });
              notify();
            }
            return;
          }
          const asset = await resolve(node.id, "materialize", `live:${source.sourceIdentity}`);
          const latest = options.canvas();
          if (!asset || disposed || latest?.id !== canvas!.id || attempts.get(node.id) !== fingerprint) return;
          // Authority rechecks every dependency and target in the same atomic command batch.
          const expectedNodeData = Object.fromEntries([...new Set([node.id, ...source.dependencyNodeIds])].map(id => [id, latest.nodeData[id] ?? null]));
          if (describe(latest, ref, node.type as MediaContentKind).sourceIdentity !== source.sourceIdentity) return;
          await options.submit([{ type: "nodeData.patch", nodeId: node.id, expectedNodeData,
            value: { outputAssetId: asset.id, status: "ready" } }, { type: "asset.upsert", asset }], `media-content:${node.id}:${randomId()}`);
          if (!disposed && attempts.get(node.id) === fingerprint) { states.set(node.id, { status: "ready", asset, sourceIdentity: source.sourceIdentity }); clearRetry(node.id); notify(); }
        } catch (error) {
          // 失败可能来自宿主重连或并发写回冲突；清掉本次指纹，下一轮画布变化/provider
          // 通知仍可重试，而不是把同一内容身份永久判为失败。
          if (!disposed && attempts.get(node.id) === fingerprint) {
            attempts.delete(node.id);
            states.set(node.id, { ...old, status: "failed", diagnostic: String(error), sourceIdentity: source.sourceIdentity });
            scheduleRetry(node.id);
            notify();
          }
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
    if (provider.subscribe) providerSubscriptions.set(provider.providerId, provider.subscribe(() => {
      if (disposed || providers.get(provider.providerId) !== provider) return;
      const canvas = options.canvas();
      for (const node of canvas?.document.nodes ?? []) {
        if (canvas!.nodeData[node.id]?.mediaContent?.providerId !== provider.providerId) continue;
        const status = states.get(node.id)?.status;
        if (status === "failed" || status === "unavailable") {
          attempts.delete(node.id);
          for (const key of receipts.keys()) if (JSON.parse(key)[1] === node.id) receipts.delete(key);
        }
      }
      schedule();
    }));
    let active = true;
    return () => {
      if (!active) return; active = false;
      providerSubscriptions.get(provider.providerId)?.();
      providerSubscriptions.delete(provider.providerId);
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
    retry(id) { attempts.delete(id); repairs.delete(id); clearRetry(id); schedule(); },
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
        // A copied provider-backed node is a frozen ordinary media node. Its
        // extension ownership must not follow the copy into another canvas.
        delete frozen.nodeData[id].managedBy;
        frozen.nodeData[id].outputAssetId = asset.id;
        frozen.assets = [...frozen.assets.filter(a => a.id !== asset.id), asset];
      }
      return frozen;
    },
    dispose() { if (disposed) return; disposed = true; unsubscribe(); for (const stop of providerSubscriptions.values()) stop(); providerSubscriptions.clear(); for (const c of controllers.keys()) c.abort(); for (const p of providers.values()) p.dispose?.(); providers.clear(); receipts.clear(); requests.clear(); states.clear(); attempts.clear(); repairs.clear(); for (const timer of retryTimers.values()) clearTimeout(timer); retryTimers.clear(); retryFailures.clear(); listeners.clear(); },
  };
}
