import type { WorldAnimationState } from "../../contract/canvas-runtime.js";

type Definition = { nodeId: string; key: string; duration: number; loop: boolean };
type Entry = Definition & { time: number };
type Clock = { now(): number; request(callback: (now: number) => void): number; cancel(id: number): void };

/** Page-local playback: one active director, independent of deselection. */
export class WorldAnimationTransport {
  private entries = new Map<string, Entry>();
  private canvasId: string | null = null;
  private target: string | null = null;
  private playing = false;
  private anchorTime = 0;
  private anchorNow = 0;
  private frame: number | null = null;
  private lastPublished = 0;
  private listeners = new Set<() => void>();
  private times: ReadonlyMap<string, number> = new Map();
  private state: WorldAnimationState = { nodeId: null, time: 0, duration: 0, playing: false, loop: false };

  constructor(private invalidate: () => void, private clock: Clock = {
    now: () => performance.now(), request: callback => requestAnimationFrame(callback), cancel: id => cancelAnimationFrame(id)
  }) {}

  snapshot = (): WorldAnimationState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  sampleTimes = (): ReadonlyMap<string, number> => this.times;
  loopFor = (nodeId: string): boolean => this.entries.get(nodeId)?.loop ?? false;

  sync(canvasId: string | null, definitions: readonly Definition[], selectedId: string | null): void {
    if (this.canvasId !== canvasId) {
      this.pause();
      this.entries.clear();
      this.target = null;
      this.canvasId = canvasId;
    }
    // Clearing selection or selecting a non-director keeps the active transport alive.
    const target = definitions.some(item => item.nodeId === selectedId) ? selectedId
      : definitions.some(item => item.nodeId === this.target) ? this.target : null;
    const targetDefinition = definitions.find(item => item.nodeId === target);
    if (this.target !== target || this.entries.get(target ?? "")?.key !== targetDefinition?.key) this.pause();
    const ids = new Set(definitions.map(item => item.nodeId));
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
    for (const definition of definitions) {
      if (this.entries.get(definition.nodeId)?.key !== definition.key) {
        this.entries.set(definition.nodeId, { ...definition, time: 0 });
      }
    }
    this.target = target;
    this.publish();
  }

  play = (): void => {
    const entry = this.current();
    if (!entry || this.playing || entry.duration <= 0) return;
    if (entry.time >= entry.duration) entry.time = 0;
    this.anchorTime = entry.time;
    this.anchorNow = this.clock.now();
    this.playing = true;
    this.publish();
    this.schedule();
  };
  pause = (): void => {
    if (this.playing) this.advance(this.clock.now());
    this.playing = false;
    if (this.frame !== null) this.clock.cancel(this.frame);
    this.frame = null;
    this.publish();
  };
  seek = (time: number): void => {
    const entry = this.current();
    if (!entry || !Number.isFinite(time)) return;
    this.pause();
    entry.time = Math.max(0, Math.min(entry.duration, time));
    this.publish();
  };
  setLoop = (loop: boolean): void => {
    const entry = this.current();
    if (!entry) return;
    const resume = this.playing;
    this.pause();
    entry.loop = loop;
    this.publish();
    if (resume) this.play();
  };
  dispose(): void {
    this.pause();
    this.entries.clear();
    this.target = null;
    this.canvasId = null;
    this.publish();
  }

  private current(): Entry | undefined { return this.entries.get(this.target ?? ""); }
  private advance(now: number): void {
    const entry = this.current();
    if (!entry) return;
    const time = this.anchorTime + Math.max(0, now - this.anchorNow) / 1000;
    entry.time = entry.loop && entry.duration > 0 ? time % entry.duration : Math.min(entry.duration, time);
    if (!entry.loop && entry.time >= entry.duration) this.playing = false;
  }
  private schedule(): void {
    if (this.frame !== null || !this.playing) return;
    this.frame = this.clock.request(now => {
      this.frame = null;
      this.advance(now);
      if (now - this.lastPublished >= 1000 / 30 || !this.playing) {
        this.lastPublished = now;
        this.publish();
      }
      this.schedule();
    });
  }
  private publish(): void {
    const entry = this.current();
    const next: WorldAnimationState = { nodeId: this.target, time: entry?.time ?? 0,
      duration: entry?.duration ?? 0, playing: this.playing, loop: entry?.loop ?? false };
    const times = new Map([...this.entries].map(([id, value]) => [id, value.time]));
    const samplesChanged = times.size !== this.times.size || [...times].some(([id, time]) => this.times.get(id) !== time);
    const stateChanged = Object.keys(next).some(key => next[key as keyof WorldAnimationState] !== this.state[key as keyof WorldAnimationState]);
    if (!samplesChanged && !stateChanged) return;
    this.times = times;
    this.state = next;
    if (samplesChanged || stateChanged) this.invalidate();
    for (const listener of this.listeners) listener();
  }
}
