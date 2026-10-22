type Update = { json: string; sequence: number; epoch: number; accepted: (generation: number) => void };

/** 一个在途请求加一个最新待发值。序号阻止迟到请求覆盖点击前的同步结算。 */
export function createNativeViewportChannel(deps: {
  send(json: string, sequence: number, signal: AbortSignal): Promise<number>;
  sync(json: string, sequence: number): number;
  failed(error: unknown): void;
}) {
  let sequence = 0, epoch = 0;
  let pending: Update | null = null;
  let flight: { update: Update; abort: AbortController } | null = null;
  let disposed = false, error: unknown = null;
  const check = () => { if (disposed) throw new Error("Native viewport disposed"); if (error) throw error; };
  const fail = (reason: unknown) => { error = reason; deps.failed(reason); };
  const drain = () => {
    if (disposed || error || flight || !pending) return;
    const update = pending; pending = null;
    const current = { update, abort: new AbortController() }; flight = current;
    void Promise.resolve().then(() => deps.send(update.json, update.sequence, current.abort.signal)).then(generation => {
      if (!disposed && update.epoch === epoch) update.accepted(generation);
    }, reason => {
      if (!disposed && update.epoch === epoch) fail(reason);
    }).finally(() => { if (flight === current) flight = null; drain(); });
  };
  const cancel = () => {
    epoch++; pending = null;
    const previous = flight; flight = null; previous?.abort.abort();
  };
  return {
    queue(json: string, accepted: Update["accepted"]) {
      check(); pending = { json, accepted, sequence: ++sequence, epoch }; drain();
    },
    /** 查询、拖动或同步提交前，结算最新导航；不把排队当成已接受。 */
    flush(): number | null {
      check();
      const update = pending ?? flight?.update;
      if (!update) return null;
      // 先使旧回调失效；原生侧仍用更大序号拦截已经进入主线程队列的旧请求。
      cancel();
      try { const generation = deps.sync(update.json, ++sequence); update.accepted(generation); return generation; }
      catch (reason) { fail(reason); throw reason; }
    },
    cancel,
    commit(json: string): number {
      check(); cancel();
      return deps.sync(json, ++sequence);
    },
    dispose() { if (disposed) return; disposed = true; cancel(); }
  };
}
