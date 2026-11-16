import type { PreparedImageResource } from "@woohaa3/contracts";
import { prepareImageResource } from "../canvas-runtime/image-worker/client.js";
import { releaseImagePixels } from "../canvas-runtime/image-worker/native-port.js";

type Prepare = (url: string, edge: number, signal?: AbortSignal) => Promise<PreparedImageResource>;

/** Page-owned LRU of browser RGBA results. Native handles remain owned by the renderer. */
export class ViewerImageCache {
  private readonly entries = new Map<string, PreparedImageResource>();
  private bytes = 0;
  private disposed = false;

  constructor(private readonly load: Prepare = prepareImageResource, private readonly budget = 48 * 1024 * 1024) {}

  async prepare(url: string, edge: number, signal?: AbortSignal): Promise<PreparedImageResource> {
    if (signal?.aborted) throw new Error("image-cancelled");
    const key = JSON.stringify([url, edge]);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const result = await this.load(url, edge, signal);
    if (signal?.aborted) {
      releaseImagePixels(result.pixels);
      throw new Error("image-cancelled");
    }
    if (!this.disposed && result.pixels instanceof Uint8Array && result.pixels.byteLength <= this.budget) {
      const previous = this.entries.get(key);
      if (previous?.pixels instanceof Uint8Array) this.bytes -= previous.pixels.byteLength;
      this.entries.delete(key);
      this.entries.set(key, result);
      this.bytes += result.pixels.byteLength;
      while (this.bytes > this.budget || this.entries.size > 8) {
        const oldest = this.entries.entries().next().value!;
        this.bytes -= (oldest[1].pixels as Uint8Array).byteLength;
        this.entries.delete(oldest[0]);
      }
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.bytes = 0;
  }
}
