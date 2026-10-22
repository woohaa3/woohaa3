/** Browser-provided main-thread evidence. Unsupported is distinct from no entries. */
export function beginBrowserTaskProfile(target: Window, started: number) {
  const Observer = (target as Window & { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  const supported = Observer?.supportedEntryTypes ?? [];
  const types = ["longtask", "long-animation-frame"].filter(type => supported.includes(type));
  const entries: Array<Record<string, unknown>> = [];
  let dropped = 0;
  const append = (items: PerformanceEntry[]) => {
    for (const item of items) {
      if (item.startTime < started) continue;
      if (entries.length >= 128) { dropped++; continue; }
      const details = item as PerformanceEntry & { blockingDuration?: number; renderStart?: number; styleAndLayoutStart?: number; scripts?: Array<{ duration: number; forcedStyleAndLayoutDuration?: number; invokerType?: string }> };
      entries.push({ type: item.entryType, atMs: item.startTime - started, durationMs: item.duration,
        blockingDurationMs: details.blockingDuration,
        scripts: details.scripts?.slice(0, 16).map(script => ({ durationMs: script.duration,
          forcedStyleAndLayoutMs: script.forcedStyleAndLayoutDuration, invokerType: script.invokerType })) });
    }
  };
  let observer: PerformanceObserver | undefined;
  const observedTypes: string[] = [];
  if (Observer && types.length) {
    observer = new Observer(list => append(list.getEntries()));
    for (const type of types) {
      try { observer.observe({ type, buffered: false }); observedTypes.push(type); } catch { /* explicitly reflected in observedTypes */ }
    }
  }
  return { stop() {
    if (observer) { append(observer.takeRecords()); observer.disconnect(); observer = undefined; }
    return { observedTypes, entries, dropped };
  } };
}
