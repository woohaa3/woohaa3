import type { BevyModule } from "./bevy-runtime-types.js";

export type CanvasScopeModule = {
  begin_canvas_scope(canvasId: string): string;
  end_canvas_scope(token: string): void;
};

export type CanvasScope = Readonly<{
  canvasId: string;
  token: string;
  sequence: number;
}>;

/** Per-runtime ownership. Old async work keeps its original immutable handle. */
export class CanvasScopeCoordinator {
  private current: CanvasScope | null = null;
  private sequence = 0;
  constructor(private module: CanvasScopeModule) {}

  open(canvasId: string): CanvasScope {
    if (!canvasId) throw new Error("Canvas identity is required");
    if (this.current?.canvasId === canvasId) return this.current;
    this.current = null;
    const token = this.module.begin_canvas_scope(canvasId);
    if (!/^[1-9][0-9]*$/.test(token)) throw new Error("Invalid canvas scope token");
    const scope = Object.freeze({ canvasId, token, sequence: ++this.sequence });
    this.current = scope;
    return scope;
  }

  isCurrent(scope: CanvasScope): boolean { return this.current === scope; }
  snapshot(): CanvasScope | null { return this.current; }

  abandon(): void { this.current = null; }

  // 仅用于同一 renderer 的受控代理替换，保留当前 handle，不开启或关闭 scope。
  rebind(module: CanvasScopeModule): void { this.module = module; }

  close(scope: CanvasScope): boolean {
    if (!this.isCurrent(scope)) return false;
    this.current = null;
    this.module.end_canvas_scope(scope.token);
    return true;
  }

  replace(module: CanvasScopeModule): void {
    const previous = this.current;
    this.current = null;
    try { if (previous) this.module.end_canvas_scope(previous.token); }
    finally { this.module = module; }
  }
}

const scopedMethods = ["begin_canvas_scope", "end_canvas_scope", "set_scene_scoped", "set_texture_scoped",
  "set_model_media_texture_scoped", "set_image_focus_details_scoped", "poll_texture_receipts_scoped"] as const;

/** Old runtimes retain their legacy ABI; a partial new ABI must fail closed. */
export function canvasScopeCapability(module: object): "legacy" | "scoped" {
  const table = module as Record<string, unknown>;
  const present = scopedMethods.filter(name => typeof table[name] === "function");
  if (present.length === 0) return "legacy";
  if (present.length !== scopedMethods.length) throw new Error("Incomplete canvas scope capability");
  return "scoped";
}

export type ScopedCanvasModule = BevyModule & Required<Pick<BevyModule,
  "begin_canvas_scope" | "end_canvas_scope" | "set_scene_scoped" | "set_texture_scoped" |
  "set_model_media_texture_scoped" | "set_image_focus_details_scoped" | "poll_texture_receipts_scoped">>;

/** Legacy ABI has no scope methods. A partial ABI still fails closed in canvasScopeCapability. */
export function scopedCanvasModule(module: BevyModule): ScopedCanvasModule | null {
  if (canvasScopeCapability(module) === "legacy") return null;
  return module as ScopedCanvasModule;
}
