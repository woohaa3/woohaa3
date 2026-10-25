/** App-owned resources with revocable page bindings. No page Context is retained by the host. */
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

export type PersistentResource = {
  dispose(): void;
  revoke?(reason: "disabled" | "identity"): boolean;
};
export type PersistentSurface<T extends PersistentResource> = {
  value: T;
  element: HTMLDivElement;
  render(content: ReactNode): void;
  /** A new binding revokes the previous binding; its disposer cannot hide the successor. */
  bind(target: HTMLElement): () => void;
  hide(): void;
  release(): void;
};
export type PersistentSurfaces = ReturnType<typeof createPersistentSurfaces>;

export function createPersistentSurfaces() {
  const owners = new Map<string, PersistentSurface<PersistentResource>>();
  const blocked = new Map<string, "disabled" | "identity">();
  let disposed = false;
  const acquire = <T extends PersistentResource>(id: string, factory: (surface: PersistentSurface<T>) => T): PersistentSurface<T> => {
    if (disposed || blocked.has(id)) throw new Error("此扩展当前不可用，请先结算保留的本地文档");
    const existing = owners.get(id);
    if (existing) return existing as PersistentSurface<T>;
    const element = document.createElement("div");
    element.dataset.persistentSurface = id;
    Object.assign(element.style, { position: "fixed", display: "none", zIndex: "60", pointerEvents: "none" });
    document.body.append(element);
    let root: Root | null = null, generation = 0, detach: (() => void) | null = null, released = false;
    const surface: PersistentSurface<T> = {
      value: null as unknown as T, element,
      render(content) { (root ??= createRoot(element)).render(content); },
      bind(target) {
        detach?.(); const token = ++generation;
        const update = () => {
          const r = target.getBoundingClientRect();
          Object.assign(element.style, { display: "block", inset: "auto", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        };
        const observer = new ResizeObserver(update); observer.observe(target);
        window.addEventListener("resize", update); window.addEventListener("scroll", update, true); update();
        detach = () => { observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
        return () => { if (generation !== token) return; surface.hide(); };
      },
      hide() { ++generation; detach?.(); detach = null; element.style.display = "none"; },
      release() {
        if (released) return; released = true; surface.hide();
        try { surface.value.dispose(); }
        finally { root?.unmount(); element.remove(); owners.delete(id); if (blocked.get(id) === "identity") blocked.delete(id); }
      }
    };
    try { surface.value = factory(surface); owners.set(id, surface); return surface; }
    catch (error) { (root as Root | null)?.unmount(); element.remove(); throw error; }
  };
  const revoke = (id: string, reason: "disabled" | "identity") => {
    const owner = owners.get(id); if (!owner) return;
    owner.hide();
    if (owner.value.revoke?.(reason)) {
      // Only the extension's local recovery controls remain. The page adapter has been revoked.
      Object.assign(owner.element.style, { display: "block", inset: "0", width: "100%", height: "100%" });
    } else owner.release();
  };
  return {
    acquire,
    setEnabled(id: string, enabled: boolean) {
      if (enabled) { if (blocked.get(id) === "disabled") blocked.delete(id); }
      else { blocked.set(id, "disabled"); revoke(id, "disabled"); }
    },
    revokeIdentity() { for (const id of owners.keys()) { blocked.set(id, "identity"); revoke(id, "identity"); } },
    dispose() { if (disposed) return; disposed = true; for (const owner of [...owners.values()]) owner.release(); owners.clear(); }
  };
}
