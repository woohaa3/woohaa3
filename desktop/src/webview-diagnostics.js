/* Document-start collector. No dependency on backend readiness or the UI renderer. */
(() => {
  if (window.top !== window.self || window.__woohaaDiagnosticsInstalled) return;
  const native = window.__WOOHAA_NATIVE__;
  if (!native) return;
  window.__woohaaDiagnosticsInstalled = true;
  const endpoint = native.platform === 'windows'
    ? 'http://woohaa-native.localhost/diagnostics' : 'woohaa-native://localhost/diagnostics';
  const send = fetch.bind(globalThis);
  const queue = [];
  let dropped = 0, sending = false, urgent = false;
  function text(value) {
    try {
      // Do not enumerate arbitrary objects: getters and custom serializers can run page code.
      const raw = value instanceof Error ? `${value.name}: ${value.message}\n${value.stack || ''}`
        : typeof value === 'string' ? value
        : value === null || ['number', 'boolean', 'undefined'].includes(typeof value) ? String(value)
        : '[object omitted]';
      return raw.replace(/(?:https?|wss?):\/\/[^\s)]+/g, url => {
        try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return '[url]'; }
      }).replace(/((?:["'])?(?:token|password|secret|authorization|api[_-]?key)(?:["'])?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
        .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]').slice(0, 2048);
    } catch { return '[unreadable]'; }
  }
  function record(event, level, message) {
    try {
      if (queue.length >= 100) { queue.shift(); dropped++; }
      queue.push({event, level, message: text(message), clientTime: Date.now()});
      if (level === 'error' && !urgent) {
        urgent = true;
        setTimeout(() => { urgent = false; void flush(); }, 0);
      }
    } catch { /* Diagnostics must never interrupt the page. */ }
  }
  window.addEventListener('error', e => {
    const resource = e.target && e.target !== window;
    record(resource ? 'resource-error' : 'error', 'error', resource
      ? `${e.target.tagName || 'resource'} ${e.target.src || e.target.href || ''}`
      : `${text(e.error || e.message)}\n${text(e.filename || '')}:${e.lineno || 0}:${e.colno || 0}`);
  }, true);
  window.addEventListener('unhandledrejection', e => record('unhandledrejection', 'error', e.reason));
  for (const level of (native.diagnosticsVerbose ? ['log', 'debug', 'warn', 'error'] : ['warn', 'error'])) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      record('console', level === 'log' ? 'info' : level, args.slice(0, 8).map(text).join(' '));
    };
  }
  globalThis.fetch = async (...args) => {
    let target = '[request]';
    try { target = text(typeof args[0] === 'string' ? args[0] : args[0]?.url || '[request]'); } catch {}
    try {
      const response = await send(...args);
      if (!response.ok) record('request-failed', 'warn', `${response.status} ${target}`);
      return response;
    } catch (error) {
      try { if (error?.name !== 'AbortError') record('request-failed', 'error', `${target} ${text(error)}`); } catch {}
      throw error;
    }
  };
  async function flush() {
    if (sending) return;
    sending = true;
    const events = [];
    let bytes = 0;
    while (queue.length && events.length < 20) {
      const nextBytes = new TextEncoder().encode(JSON.stringify(queue[0])).length;
      if (bytes + nextBytes > 60 * 1024) break;
      bytes += nextBytes; events.push(queue.shift());
    }
    const lost = dropped; dropped = 0;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await send(endpoint, {
        method: 'POST', headers: {'Content-Type': 'application/json', 'X-Woohaa-Token': native.token},
        body: JSON.stringify({events, dropped: lost, visibility: document.visibilityState}), signal: controller.signal,
      });
      if (!response.ok) throw Error('diagnostics rejected');
    } catch { dropped += events.length + lost; }
    finally { clearTimeout(timeout); sending = false; }
  }
  // Only fixed operation names; no DOM text, inputs or document contents.
  window.addEventListener('pagehide', () => { record('pagehide', 'info', 'pagehide'); void flush(); });
  document.addEventListener?.('visibilitychange', () => { void flush(); });
  window.addEventListener('pageshow', () => record('pageshow', 'info', 'pageshow'));
  record('collector-ready', 'info', 'document-start');
  setInterval(flush, 1000);
})();
