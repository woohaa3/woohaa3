import type { InteractionRelease, InteractionSample } from "./interaction-performance.js";

/** Separate confirmation records: never mutate an event that may already be uploaded. */
export function createCommandConfirmation(
  target: Pick<Window, "setTimeout" | "clearTimeout">,
  now: () => number,
  context: () => InteractionSample["context"],
  append: (sample: InteractionSample) => void
) {
  let sequence = 0;
  let disposed = false;
  const timers = new Map<number, number>();
  return {
    observe(result: void | Promise<"committed" | "rejected" | "unavailable">, release: InteractionRelease): number | undefined {
      if (disposed || timers.size >= 64) return undefined;
      const id = ++sequence, startedAt = now(), eventContext = context();
      const finish = (outcome: "committed" | "rejected" | "unavailable") => {
        const timer = timers.get(id);
        if (timer === undefined) return;
        target.clearTimeout(timer);
        timers.delete(id);
        if (!disposed) append({
          kind: "drag", source: "command", phase: "settled", release,
          startedAt, handlerMs: 0, nextRafMs: null, hidden: false,
          context: eventContext, commandId: id,
          command: { outcome, waitMs: Math.max(0, now() - startedAt) }
        });
      };
      timers.set(id, target.setTimeout(() => finish("unavailable"), 30_000));
      void Promise.resolve(result).then(value => finish(value ?? "unavailable"), () => finish("rejected"));
      return id;
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) target.clearTimeout(timer);
      timers.clear();
    }
  };
}
