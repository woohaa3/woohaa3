import {
  DEFAULT_MODEL_PREVIEW,
  type BevyModelPreview,
} from "@woohaa3/contracts";

/** Local viewing state only. No nodeData/modelCameras writes. */
const views = new Map<string, BevyModelPreview>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
export const modelPreviewStore = {
  get: (id: string): BevyModelPreview => views.get(id) ?? DEFAULT_MODEL_PREVIEW,
  snapshot: (): ReadonlyMap<string, BevyModelPreview> => views,
  set(id: string, patch: Partial<BevyModelPreview>) {
    const previous = this.get(id),
      next = { ...previous, ...patch };
    const beforeOffset = previous.targetOffset ?? [0, 0, 0],
      nextOffset = next.targetOffset ?? [0, 0, 0];
    if (
      previous.azimuth === next.azimuth &&
      previous.elevation === next.elevation &&
      previous.distanceScale === next.distanceScale &&
      beforeOffset.every((value, index) => value === nextOffset[index])
    )
      return;
    views.set(id, next);
    emit();
  },
  prune(ids: ReadonlySet<string>) {
    let changed = false;
    for (const id of views.keys())
      if (!ids.has(id)) {
        views.delete(id);
        changed = true;
      }
    if (changed) emit();
  },
  clear() {
    if (views.size) {
      views.clear();
      emit();
    }
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
