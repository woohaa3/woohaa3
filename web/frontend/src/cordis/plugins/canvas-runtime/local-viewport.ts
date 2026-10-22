/**
 * 本地视口存储（change: replace-godot-canvas-runtime-with-bevy）。
 *
 * 视口（平移/缩放）**不是规范画布的一部分**：不同步、不持久化到服务端、不推进 revision。
 * 它由各浏览器独立维护，并按 canvasId 记在 `localStorage`，让本浏览器刷新后回到上次位置。
 *
 * 纯本地状态：不写 Y.Doc、不发命令、不参与 CanvasService 命令批次。
 */
import { clampWoohaa3CanvasZoom, type Woohaa3CanvasViewport } from "@woohaa3/contracts";

const STORAGE_PREFIX = "woohaa3:viewport:";
const DEFAULT_VIEWPORT: Woohaa3CanvasViewport = { x: 0, y: 0, zoom: 1 };

export function createLocalViewportStore(canvasId: string, storage?: Pick<Storage, "getItem" | "setItem">) {
  const backing = storage ?? (typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : undefined);
  const key = `${STORAGE_PREFIX}${canvasId}`;
  let current: Woohaa3CanvasViewport = read(backing, key);

  function read(store: Pick<Storage, "getItem"> | undefined, storageKey: string): Woohaa3CanvasViewport {
    if (!store) return { ...DEFAULT_VIEWPORT };
    try {
      const raw = store.getItem(storageKey);
      if (!raw) return { ...DEFAULT_VIEWPORT };
      const parsed = JSON.parse(raw) as Partial<Woohaa3CanvasViewport>;
      return {
        x: Number.isFinite(parsed.x) ? (parsed.x as number) : 0,
        y: Number.isFinite(parsed.y) ? (parsed.y as number) : 0,
        zoom: clampWoohaa3CanvasZoom(Number.isFinite(parsed.zoom) ? (parsed.zoom as number) : 1)
      };
    } catch {
      return { ...DEFAULT_VIEWPORT };
    }
  }

  return {
    get(): Woohaa3CanvasViewport {
      return { ...current };
    },
    set(viewport: Woohaa3CanvasViewport): void {
      current = {
        x: viewport.x,
        y: viewport.y,
        zoom: clampWoohaa3CanvasZoom(viewport.zoom)
      };
      if (!backing) return;
      try {
        backing.setItem(key, JSON.stringify(current));
      } catch {
        // 存储不可用（隐私模式/配额）：静默忽略，仅保留内存值。
      }
    },
    reset(): void {
      current = { ...DEFAULT_VIEWPORT };
      try {
        backing?.setItem(key, JSON.stringify(current));
      } catch {
        // 忽略。
      }
    }
  };
}

export type LocalViewportStore = ReturnType<typeof createLocalViewportStore>;
