/* Explicit development capture. Numeric timings only; never console output. */
(() => {
  const native = window.__WOOHAA_NATIVE__;
  if (window.top !== window.self || !native?.performanceCapture || window.__woohaaPerformance) return;
  const endpoint = native.platform === 'windows'
    ? 'http://woohaa-native.localhost/performance' : 'woohaa-native://localhost/performance';
  const send = fetch.bind(globalThis);
  const queue = [];
  let dropped = 0, sending = false, metadataPending = true;
  const capabilities = {
    performance: typeof performance !== 'undefined' && typeof performance.now === 'function' ? 'collected' : 'unsupported',
    raf: typeof requestAnimationFrame === 'function' ? 'not-collected' : 'unsupported',
    longtask: typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask') ? 'not-collected' : 'unsupported',
    clockPair: 'not-collected', nativeInterval: 'not-collected',
  };
  let clockPair;
  if (typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)) {
    const before = performance.now();
    void send(endpoint.replace(/performance$/, 'performance-clock'), {
      headers: { 'X-Woohaa-Token': native.token },
    }).then(response => response.ok ? response.json() : Promise.reject()).then(pair => {
      const after = performance.now();
      if (![pair.epochMs, pair.monotonicMs, pair.uncertaintyMs].every(n => Number.isFinite(n) && n >= 0)) throw Error('clock unavailable');
      clockPair = { ...pair, webviewEpochMs: performance.timeOrigin + (before + after) / 2,
        uncertaintyMs: pair.uncertaintyMs + (after - before) / 2 };
      capabilities.clockPair = 'collected'; metadataPending = true;
    }).catch(() => { capabilities.clockPair = 'dropped'; metadataPending = true; });
  }
  window.__woohaaPerformance = sample => {
    if (queue.length >= 1024) { dropped++; return; }
    queue.push(sample);
  };
  async function flush() {
    if (sending || (!queue.length && !metadataPending && !dropped)) return;
    sending = true;
    const samples = queue.splice(0, 128), lost = dropped;
    dropped = 0; metadataPending = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await send(endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Woohaa-Token': native.token },
        body: JSON.stringify({ samples, dropped: lost, capabilities: { ...capabilities, performance: lost ? 'dropped' : capabilities.performance }, ...(clockPair ? { clockPair } : {}) }), signal: controller.signal });
      if (!response.ok || !(await response.json()).ok) throw Error('capture rejected');
    } catch { dropped += samples.length + lost; metadataPending = true; }
    finally { clearTimeout(timeout); sending = false; }
  }
  setInterval(() => { void flush(); }, 250);
  window.addEventListener('pagehide', () => { void flush(); });
})();
