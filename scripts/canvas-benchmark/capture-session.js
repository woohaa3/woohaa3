/* Paste this entire file into the application's DevTools console (or a Snippet).
 * Explicit, in-memory diagnostics only: no background polling, uploads, or scene writes.
 */
(() => {
  const target = globalThis;
  let running = false;
  const phases = [];
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const parse = value => typeof value === "string" ? JSON.parse(value) : value;
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const round = value => finite(value) ? Math.round(value * 100) / 100 : null;
  const delta = (before, after) => finite(before) && finite(after) && after >= before ? after - before : null;
  const perFrame = (before, after, total, frames) => {
    const n = delta(before?.[frames], after?.[frames]);
    const ms = delta(before?.[total], after?.[total]);
    return n > 0 && ms !== null ? round(ms / n) : null;
  };

  async function snapshot(runtime) {
    const started = performance.now();
    let work = null;
    let workReason = null;
    try {
      if (runtime.readSceneDiagnostics) {
        const result = await runtime.readSceneDiagnostics();
        work = result.value;
        workReason = result.reason;
      } else {
        // Older frontends only expose the synchronous diagnostic boundary.
        work = runtime.getWorkDiagnostics?.() ?? null;
        if (!work) workReason = "unsupported";
      }
    } catch {
      workReason = "diagnostics-failed";
    }
    const scene = runtime.lastScene?.();
    const health = parse(runtime.rawHealth?.());
    const atMs = performance.now();
    return clone({
      atMs, readMs: atMs - started,
      runtimeGeneration: runtime.generation?.(),
      backend: runtime.rendererBackend?.() ?? "unknown",
      health, work, workReason,
      scene: scene ? {
        canvasId: scene.canvasId, revision: scene.revision,
        nodes: scene.nodes?.length, viewport: scene.viewport,
        focused: Boolean(scene.modelFocus)
      } : null,
      surface: { width: target.innerWidth, height: target.innerHeight, pixelRatio: target.devicePixelRatio },
      js: target.__canvasSceneDiagnostics,
      residency: target.__canvasResidency?.snapshot?.(),
      overviewCache: target.__canvasOverviewCache?.snapshot?.()
    });
  }

  target.__canvasPerfProbe = {
    async sample(label, seconds = 20) {
      if (running) throw new Error("A sample is already running");
      if (phases.length >= 12) throw new Error("12-phase limit reached; export and reinstall the snippet");
      if (typeof label !== "string" || !label.trim() || label.length > 64) throw new Error("Use a short phase label");
      if (!finite(seconds) || seconds < 1 || seconds > 60) throw new Error("Sample duration must be 1–60 seconds");
      const runtime = target.__bevyRuntime;
      if (!runtime?.isReady?.()) throw new Error("Open the main canvas and wait for its renderer");
      const doc = target.document;
      let hidden = doc?.visibilityState === "hidden";
      const visibility = () => { hidden ||= doc.visibilityState === "hidden"; };
      doc?.addEventListener("visibilitychange", visibility);
      running = true;
      try {
        const before = await snapshot(runtime);
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        const after = await snapshot(runtime);
        const reasons = [];
        if (hidden) reasons.push("page-hidden");
        if (target.__bevyRuntime !== runtime || before.runtimeGeneration !== after.runtimeGeneration) reasons.push("runtime-changed");
        if (before.scene?.canvasId !== after.scene?.canvasId || before.scene?.revision !== after.scene?.revision) reasons.push("scene-changed");
        if (JSON.stringify(before.surface) !== JSON.stringify(after.surface)
          || JSON.stringify(before.scene?.viewport) !== JSON.stringify(after.scene?.viewport)
          || before.scene?.focused !== after.scene?.focused) reasons.push("view-changed");
        const frames = delta(before.health?.renders, after.health?.renders);
        const updates = delta(before.health?.updates, after.health?.updates);
        if (!(frames > 0)) reasons.push("no-render-progress");
        const elapsedMs = after.atMs - before.atMs;
        const a = before.work?.renderStages?.work;
        const b = after.work?.renderStages?.work;
        const draws = delta(before.health?.drawCalls3d, after.health?.drawCalls3d);
        const summary = {
          label, valid: reasons.length === 0, reasons: reasons.join(","),
          renderFps: frames === null ? null : round(frames * 1000 / elapsedMs),
          updateFps: updates === null ? null : round(updates * 1000 / elapsedMs),
          drawCalls: frames > 0 && draws !== null ? round(draws / frames) : null,
          queueMs: perFrame(a, b, "queueMs", "queueFrames"),
          prepareMs: perFrame(a, b, "prepareMs", "prepareFrames"),
          renderMs: perFrame(a, b, "renderMs", "renderFrames"),
          modelRoots: after.work?.models?.roots ?? null,
          modelEntities: after.work?.models?.modelEntities ?? null,
          activePreviews: after.work?.previews?.active ?? null,
          activeShotPreviews: after.work?.shotPreviews?.active ?? null,
          pacing: after.work?.pacing ?? null,
          boundaryReadMs: round(before.readMs + after.readMs)
        };
        phases.push({ at: new Date().toISOString(), summary, before, after });
        target.console.table([summary]);
        return summary;
      } finally {
        doc?.removeEventListener("visibilitychange", visibility);
        running = false;
      }
    },
    report: () => clone({ version: 1, userAgent: target.navigator?.userAgent,
      metric: "Bevy PostCleanup completion; CPU wall time, not GPU present/time", phases }),
    json: () => JSON.stringify(target.__canvasPerfProbe.report(), null, 2)
  };
  target.console.info('Ready: await __canvasPerfProbe.sample("initial-empty")');
})();
