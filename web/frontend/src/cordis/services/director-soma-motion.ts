import { decodeSceneAreaData, executeWorldAnimationScript, type ServerCanvas, type WorldSomaClipTrack, type PreparedSomaMotion } from '@woohaa3/contracts';
import { resolveCanonicalMediaUrl } from './media-remote.js';
import { loadSomaMotion } from './soma-motion.js';

type Entry = { track: WorldSomaClipTrack; url: string; abort: AbortController; value?: PreparedSomaMotion; error?: unknown; pending?: Promise<void> };
const keyFor = (track: WorldSomaClipTrack) => JSON.stringify([track.assetId, track.checksum, track.fps, track.frameCount]);
/** Page-owned prepared clips. No decoded arrays or clocks live in the document. */
export class DirectorSomaMotionCache {
  private entries = new Map<string, Entry>();
  private identity: unknown;
  private disposed = false;
  private active = 0;
  private scope = "";
  private readonly maxPreparedBytes = 512 * 1024 * 1024;
  private listeners = new Set<() => void>();
  private status: string | null = null;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.status;
  private publish(): void {
    const error = [...this.entries.values()].find(entry => entry.error)?.error;
    const status = error ? `动作加载失败：${error instanceof Error ? error.message : String(error)}` : [...this.entries.values()].some(entry => !entry.value) ? '动作加载中…' : null;
    if (status !== this.status) { this.status = status; for (const listener of this.listeners) listener(); }
  }
  private changed: () => void = () => {};
  sync(canvas: ServerCanvas | null | undefined, changed: () => void, areaIds?: ReadonlySet<string>): void {
    this.changed = changed;
    const scope = areaIds ? [...areaIds].sort().join("\0") : "*";
    if ((this.identity === canvas && this.scope === scope) || this.disposed) return;
    this.scope = scope;
    this.identity = canvas;
    const wanted = new Map<string, Entry>();
    if (canvas) for (const node of canvas.document.nodes) {
      if (areaIds && !areaIds.has(node.id)) continue;
      const area = decodeSceneAreaData(canvas.nodeData[node.id]?.sceneArea);
      if (!area.ok || !area.value.animationScript) continue;
      const result = executeWorldAnimationScript(area.value.animationScript.script, area.value.animationScript);
      if (!result.ok) continue;
      for (const track of result.ir.somaTracks ?? []) {
        const key = keyFor(track);
        if (wanted.has(key)) continue;
        const asset = canvas.assets.find(asset => asset.id === track.assetId);
        const url = resolveCanonicalMediaUrl(asset, canvas.id);
        const old = this.entries.get(key);
        wanted.set(key, old?.url === url ? old : { track, url: url ?? '', abort: new AbortController(), ...(!url ? { error: new Error('动作资源不存在') } : {}) });
      }
    }
    for (const [key, entry] of this.entries) if (wanted.get(key) !== entry) entry.abort.abort();
    this.entries = wanted;
    this.pump();
    this.publish();
  }
  /** Explicit user retry; rendering/sync never loops on a failed or malformed asset. */
  retryFailed(): void {
    if (this.disposed) return;
    for (const [key, entry] of this.entries) {
      if (!entry.error || !entry.url) continue;
      entry.abort.abort();
      this.entries.set(key, { track: entry.track, url: entry.url, abort: new AbortController() });
    }
    this.pump();
    this.publish();
  }
  resolve = (track: WorldSomaClipTrack): PreparedSomaMotion | undefined => this.entries.get(keyFor(track))?.value;
  private pump(): void {
    if (this.disposed) return;
    for (const entry of this.entries.values()) {
      if (this.active >= 2) break;
      if (entry.pending || entry.error || entry.value) continue;
      this.active++;
      entry.pending = loadSomaMotion(entry.url, entry.abort.signal, entry.track.fps, entry.track.frameCount, entry.track.checksum).then(value => {
        if (!entry.abort.signal.aborted && this.entries.get(keyFor(entry.track)) === entry) { const bytes = (motion: PreparedSomaMotion) => Object.values(motion).reduce<number>((sum, value) => sum + (ArrayBuffer.isView(value) ? value.byteLength : 0), 0);
          const used = [...this.entries.values()].reduce((sum, current) => sum + (current.value ? bytes(current.value) : 0), 0);
          if (used + bytes(value) > this.maxPreparedBytes) entry.error = new Error('当前导演动作超过内存预算（512 MB）');
          else { entry.value = value; this.changed(); } }
      }, error => { entry.error = error; }).finally(() => { this.active--; this.pump(); this.publish(); });
    }
  }
  async ready(): Promise<void> {
    for (;;) {
      const entries = [...this.entries.values()];
      const failed = entries.find(entry => entry.error);
      if (failed) throw failed.error;
      if (entries.every(entry => entry.value)) return;
      await Promise.all(entries.flatMap(entry => entry.pending ? [entry.pending] : []));
    }
  }
  dispose(): void { this.disposed = true; for (const entry of this.entries.values()) entry.abort.abort(); this.entries.clear(); }
}
