export { createScenePackageClient, decodeReceipt } from '../../services/scene-package-client.js';
export type { SceneReceipt, SceneJob } from '../../services/scene-package-client.js';

/** Numeric counters only. Never serialize runtime payloads or error/source strings. */
export function numericTree(value: unknown, depth=0): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return {};
  const result: Record<string,unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0,256)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || /body|script|source|path|url|credential|token|media|content|title/i.test(key)) continue;
    if(typeof item === 'number' && Number.isFinite(item)) result[key] = item;
    else if(typeof item === 'boolean') result[key] = item;
    else if(item && typeof item === 'object' && !Array.isArray(item)) {
      const nested = numericTree(item,depth+1);
      if(Object.keys(nested).length) result[key] = nested;
    }
  }
  return result;
}
/** A bounded rolling window of frontend rAF intervals, never GPU present times. */
export class SceneFrameWindow {
  private readonly times = new Float64Array(16384);
  private readonly intervals = new Float64Array(16384);
  private capacityDropped=0;
  private start=0; private count=0; private last:number|null=null;
  push(at:number) {
    if(!Number.isFinite(at)) return;
    this.trim(at);
    if(this.last !== null && at >= this.last) {
      if(this.count===16384) {this.capacityDropped++;this.start=(this.start+1)%16384;this.count--;}
      const index=(this.start+this.count)%16384;
      this.times[index]=at;this.intervals[index]=at-this.last;this.count++;
    }
    this.last=at;this.trim(at);
  }
  private trim(now:number) {
    while(this.count && this.times[this.start]<now-30000){this.start=(this.start+1)%16384;this.count--;}
  }
  snapshot(now:number) {this.trim(now);return {windowMs:30000,capacity:16384,capacityDropped:this.capacityDropped,intervalsMs:Array.from({length:this.count},(_,i)=>this.intervals[(this.start+i)%16384])};}
  clear(){this.capacityDropped=0;this.start=0;this.count=0;this.last=null;}
}

export type SceneEntryOrigin='first-import'|'reopen'|'reset';
const sceneEntryOrigins=new Map<string,SceneEntryOrigin>();
export function markSceneEntry(canvasId:string,origin:SceneEntryOrigin){sceneEntryOrigins.set(canvasId,origin);if(sceneEntryOrigins.size>32)sceneEntryOrigins.delete(sceneEntryOrigins.keys().next().value!);}
export function consumeSceneEntry(canvasId:string):SceneEntryOrigin {const origin=sceneEntryOrigins.get(canvasId)??'reopen';sceneEntryOrigins.delete(canvasId);return origin;}
