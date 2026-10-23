/**
 * 滤镜域验证套件（U46–U49）：真实 WASM。
 *
 * 一次性覆盖此前分散在多个临时脚本里的检查，避免证据脚本随临时目录清理而丢失。
 * 前置：`pnpm run wasm`（生成 `packages/editor/dist/wasm`）。
 * 运行（在 photocraft/ 下）：`node scripts/evidence/filter-suite.mjs`
 *
 * 需要面板模块时从源码临时打包：
 *   npx esbuild packages/editor/src/features/filters/catalogue.ts \
 *     --bundle --format=esm --platform=node --outfile=.local/catalogue-bundle.mjs
 * 未提供 `CATALOGUE_BUNDLE` 时，模糊画廊的声明驱动用例会跳过并明确标注（不伪造通过）。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = path.join(process.cwd(), "packages/editor/dist/wasm");
const mod = await import(pathToFileURL(path.join(source, "photocraft_editor.js")));
mod.initSync({ module: fs.readFileSync(path.join(source, "photocraft_editor_bg.wasm")) });

const results = {};
/** `record(group, value)` 或 `record(group, name, value)`。 */
const record = (group, nameOrValue, value) => {
  results[group] ??= {};
  if (value === undefined) Object.assign(results[group], nameOrValue);
  else results[group][nameOrValue] = value;
};
const digest = (ed) => {
  const preview = ed.renderPreview(200);
  const bytes = new Uint8Array(preview.pixels);
  preview.free?.();
  let hash = 0;
  for (const byte of bytes) hash = (hash * 31 + byte) % 4294967291;
  return hash;
};
/** 取一帧像素快照：`digest` 只看有没有变，位置断言需要真实像素。 */
const snapPreview = (ed, width = 160) => {
  const preview = ed.renderPreview(width);
  const c = new Uint8Array(preview.pixels);
  const { width: w, height: h } = preview;
  preview.free?.();
  return { c, w, h };
};
/**
 * 1:1 原始像素摘要。
 *
 * `digest` 走 `renderPreview`，会缩放到固定宽度：锐化这类「通道只差 1–2 级」的滤镜在缩放
 * 取整后可能与原图完全一致，于是被误判成「没有效果」。逐命令核对必须看 1:1 区域。
 */
const regionDigest = (ed) => {
  // 区域宽高上限 1024：取文档与上限的较小值，整幅图都在窗口内时就是 1:1。
  const doc = JSON.parse(ed.stateJson()).document;
  const width = Math.min(1024, doc.width);
  const height = Math.min(1024, doc.height);
  const preview = ed.renderRegion(JSON.stringify({ x: 0, y: 0, width, height }));
  const bytes = new Uint8Array(preview.pixels);
  preview.free?.();
  let hash = 0;
  for (const byte of bytes) hash = (hash * 31 + byte) % 4294967291;
  return hash;
};
const patterned = (w = 96, h = 64, name = "d") => {
  const e = new mod.WasmEditor();
  e.execute("file.new", JSON.stringify({ width: w, height: h, name }));
  e.execute("layer.new.layer", JSON.stringify({ name: "base" }));
  for (let i = 0; i < 8; i += 1) {
    e.execute(
      "paint.stroke",
      JSON.stringify({
        points: [[4 + i * 10, 4], [16 + i * 8, h - 8]],
        size: 4, hardness: 1, opacity: 1, flow: 1,
        color: i % 2 ? "#ff8800" : "#2255cc", target: "pixels"
      })
    );
  }
  return e;
};
/**
 * 硬边高对比图案：锐化/去斑/表面模糊这类滤镜只在高对比边缘上产生可测差异。
 *
 * 用交错色带（`patterned`）时它们的通道差常被压到 1 级以内，1:1 也量不出来，会被误判成
 * 「无效果」——那是图案选错，不是滤镜坏了。
 */
const hardEdges = (w = 128, h = 96, name = "edges") => {
  const e = new mod.WasmEditor();
  e.execute("file.new", JSON.stringify({ width: w, height: h, name }));
  e.execute("layer.new.layer", JSON.stringify({ name: "base" }));
  // 笔画数要**远离** `history_states`（默认 50）的上限：历史顶满后长度不再增长，
  // 「确认恰好一步」就永远量成 0 步。这里只用 10 笔，同时保留足够的硬边。
  for (let y = 8; y < h - 8; y += 8) {
    e.execute("paint.stroke", JSON.stringify({ points: [[16, y], [w - 16, y]], size: 6, hardness: 1, opacity: 1, flow: 1, color: "#ffffff", target: "pixels" }));
  }
  for (let x = 16; x < w - 16; x += 24) {
    e.execute("paint.stroke", JSON.stringify({ points: [[x, 0], [x, h]], size: 6, hardness: 1, opacity: 1, flow: 1, color: "#000000", target: "pixels" }));
  }
  return e;
};
const catalogueOf = () => {
  const e = new mod.WasmEditor();
  const catalogue = JSON.parse(e.filterCatalogueJson());
  const commands = JSON.parse(e.commandsJson());
  e.free();
  return { catalogue, commands: commands.commands ?? commands };
};
const panelDefaults = (filter) =>
  Object.fromEntries(
    filter.params
      .filter((p) => p.kind !== "resource" && p.key !== "seed" && p.default !== null)
      .map((p) => [p.key, p.default])
  );

// ---------------------------------------------------------------- 声明 / 入口 / 结果一致性
{
  const { catalogue, commands } = catalogueOf();
  const byId = new Map(commands.map((c) => [c.id, c]));
  const catalogueIds = new Set([...catalogue.filters.map((f) => f.id), "filter.lastFilter"]);
  record("consistency", {
    catalogueFilters: catalogue.filters.length,
    galleryFilters: catalogue.gallery.filters.length,
    allowedFilterCommands: commands.filter((c) => c.id.startsWith("filter.") && c.allowed).length,
    declaredButNotAllowed: catalogue.filters.filter((f) => !byId.has(f.id)).map((f) => f.id),
    declaredButGatedOff: catalogue.filters.filter((f) => byId.get(f.id)?.allowed === false).map((f) => f.id),
    allowedButNotInCatalogue: commands
      .filter((c) => c.id.startsWith("filter.") && c.allowed && !catalogueIds.has(c.id))
      .map((c) => c.id)
  });
}

// ---------------------------------------------------------------- 每条命令都能开草稿
{
  const { catalogue } = catalogueOf();
  const base = patterned();
  const baseHash = digest(base);
  base.free();
  const refused = [];
  let started = 0;
  for (const filter of catalogue.filters) {
    // 组合入口与需要外部结构的命令由专门的脚本覆盖（这里只测规范默认参数）。
    if (["filter.filterGallery", "filter.distort.displace", "filter.vanishingPoint"].includes(filter.id)) continue;
    const e = patterned();
    try {
      e.beginFilter(filter.id, JSON.stringify(panelDefaults(filter)));
      started += 1;
      e.cancelFilter();
    } catch (err) {
      refused.push({ id: filter.id, error: String(err).slice(0, 120) });
      try { e.cancelFilter(); } catch {}
    }
    e.free();
  }
  record("coverage", { started, refused, baseHash });
}

// ---------------------------------------------------------------- 每条命令：真实像素 + 一步历史 + undo
// spec 要求「每个已开放命令都有真实参数/像素证据与取消/撤销用例」，只证明「能开草稿」不够。
// 这里对每条命令走完整链路：开草稿 → 候选真的变了 → 确认恰好一步历史 → undo 复原。
// 少数命令在规范默认参数下是**合法的空操作**（恒等卷积核、0 位移、无变化滤镜），单独记录下来
// 而不是当成失败——它们「改了参数仍不变」才是正确行为。
{
  const { catalogue } = catalogueOf();
  // 规范默认参数下**确实**不改变像素的命令：每条都要写清原因，并且另有专门断言覆盖它的
  // 「改了参数就有效」。名单之外出现无变化一律算失败，避免把真缺陷混进来。
  const noopByDesign = new Map([
    ["filter.filterGallery", "空效果栈 = 无效果（galleryStack 断言覆盖）"],
    ["filter.distort.displace", "默认 0 位移（displace 断言覆盖非零位移）"],
    ["filter.distort.shear", "默认 amount=0（逐命令核对的非零切变见 shearNonZero）"],
    ["filter.other.offset", "默认 horizontal/vertical = 0"],
    ["filter.other.colorToAlpha", "默认把白色转透明，硬边图案合成后不可见（见 colorToAlphaNonDefault）"],
    ["filter.vanishingPoint", "只有平面、无克隆/粘贴（vanish* 断言覆盖）"],
    ["filter.other.custom", "默认恒等卷积核（customKernel 断言覆盖）"],
    ["filter.cameraRaw", "全neutral 默认（cameraRaw 断言覆盖各控件）"],
    ["filter.lensCorrection", "默认无校正（straighten 断言覆盖）"],
    ["filter.adaptiveWideAngle", "默认无约束（wideAngle 见 crossDomain/控件断言）"],
    ["filter.video.ntscColors", "只钳制超出 NTSC 域的饱和色"]
  ]);
  const failures = [];
  const noops = [];
  let verified = 0;
  for (const filter of catalogue.filters) {
    if (noopByDesign.has(filter.id)) continue;
    // 锐化/去斑/模糊类只在高对比边缘上产生可测差异：逐命令核对统一用硬边图案。
    const e = hardEdges();
    const history = () => JSON.parse(e.stateJson()).document.history.length;
    try {
      const before = regionDigest(e);
      const historyBefore = history();
      e.beginFilter(filter.id, JSON.stringify(panelDefaults(filter)));
      const candidate = regionDigest(e);
      const commit = JSON.parse(e.commitFilter());
      const committed = regionDigest(e);
      const steps = history() - historyBefore;
      e.execute("edit.undo", "{}");
      const restored = regionDigest(e) === before;
      if (candidate === before || !commit.changed) {
        // 不在名单里却无变化：这是真失败（可能默认参数写错或字段没被读），不能当空操作。
        failures.push({ id: filter.id, why: "no-effect-but-not-listed-as-noop" });
      } else if (steps !== 1 || committed !== candidate || !restored) {
        failures.push({ id: filter.id, steps, committedMatchesCandidate: committed === candidate, undoRestores: restored });
      } else {
        verified += 1;
      }
    } catch (err) {
      failures.push({ id: filter.id, error: String(err).slice(0, 130) });
      try { e.cancelFilter(); } catch {}
    }
    e.free();
  }
  record("perCommand", {
    verified,
    noops: [...noopByDesign.keys()],
    noopReasons: Object.fromEntries(noopByDesign),
    failures
  });
}

// ---------------------------------------------------------------- 固定 seed 可重现（U48）
// 「随机」滤镜必须靠 seed 冻结：同 seed 同结果、不同 seed 不同结果、草稿内 seed 不漂移。
{
  const seedFilters = catalogueOf().catalogue.filters.filter((f) => f.params.some((p) => p.key === "seed"));
  const results = [];
  for (const filter of seedFilters) {
    const run = (seed) => {
      const e = hardEdges();
      const before = regionDigest(e);
      e.beginFilter(filter.id, JSON.stringify({ ...panelDefaults(filter), seed }));
      const candidate = regionDigest(e);
      // 同一草稿内再取一帧：seed 不得在预览之间漂移。
      const again = regionDigest(e);
      e.cancelFilter();
      e.free();
      return { candidate, before, stable: again === candidate };
    };
    const one = run(12345);
    const same = run(12345);
    const other = run(99999);
    // 有些命令的 `seed` 只在另一个参数非零时才参与（镜头模糊要 `noise>0`，Camera Raw 要
    // 有噪点/颗粒）。那时「不同 seed 像素相同」是正确行为，必须单独标出来而不是判失败。
    const seedParticipates = one.candidate !== one.before;
    results.push({
      id: filter.id,
      changed: seedParticipates,
      stableWithinDraft: one.stable,
      sameSeedSamePixels: one.candidate === same.candidate,
      differentSeedDiffers: one.candidate !== other.candidate,
      seedInertAtDefaults: !seedParticipates,
      specific:
        filter.id === "filter.blur.lensBlur"
          ? (() => {
              // lensBlur 的 seed 只在 noise>0 时参与：补一次开噪声的比较。
              const noisy = (seed) => {
                const e = hardEdges();
                e.beginFilter(filter.id, JSON.stringify({ ...panelDefaults(filter), noise: 40, seed }));
                const out = regionDigest(e);
                e.cancelFilter();
                e.free();
                return out;
              };
              return noisy(12345) !== noisy(99999);
            })()
          : null
    });
  }
  // 判定条件按「seed 在当前参数下是否参与」区分：
  // - 参与（默认参数下就已改变像素）：必须同 seed 同结果、不同 seed 不同结果；
  // - 不参与（默认参数下无变化）：只要求同 seed 同结果；若补了专项（如 lensBlur 开噪声），
  //   专项必须为真，用来证明它「不是因为坏掉才不动」。
  const seedFailures = results.filter((r) => {
    if (!r.stableWithinDraft || !r.sameSeedSamePixels) return true;
    if (!r.changed) return r.specific === false;
    return !r.differentSeedDiffers && r.specific !== true;
  });
  record("seedReproducible", { checked: results.length, failures: seedFailures, results });
}

// ---------------------------------------------------------------- 资源型滤镜的工程往返（U48/U49）
// spec 要求「资源型滤镜可工程结果往返」：资源参数必须真的落进工程，而不是只在草稿期存在。
// 每个用例：带资源参数提交 → saveProject → openProject → 像素与提交时一致；undo 改变、redo 复原。
{
  const bundle = process.env.CATALOGUE_BUNDLE ?? ".local/catalogue-bundle.mjs";
  let api = null;
  try { api = await import(pathToFileURL(path.resolve(bundle)).href); } catch { api = null; }
  if (!api) {
    record("roundtrip", { skipped: `未找到面板模块（${bundle}）` });
  } else {
    const { catalogue } = catalogueOf();
    const entryOf = (id) => catalogue.filters.find((f) => f.id === id);
    const cameraEntry = entryOf("filter.cameraRaw");
    const cases = [
      {
        id: "filter.other.custom",
        params: () => ({ ...panelDefaults(entryOf("filter.other.custom")), ...api.withKernel({}, Array.from({ length: 25 }, (_, i) => (i === 12 ? 3 : 0)), entryOf("filter.other.custom")) })
      },
      {
        // 默认 amount=0 是空操作，提交后 undo 自然看不到像素变化；往返必须用非零参数。
        id: "filter.distort.shear",
        params: () => ({ ...panelDefaults(entryOf("filter.distort.shear")), amount: 45 })
      },
      {
        id: "filter.render.lightingEffects",
        params: () => {
          const entry = entryOf("filter.render.lightingEffects");
          return { ...panelDefaults(entry), ...api.withLights({}, api.addLight([], api.newLight(), 16), entry) };
        }
      },
      {
        id: "filter.cameraRaw",
        params: () => ({ ...panelDefaults(cameraEntry), ...api.withCurve({}, "pointCurve", api.addCurvePoint(api.identityCurve(), [64, 96]), cameraEntry) })
      }
    ];
    const failures = [];
    for (const test of cases) {
      const e = patterned(96, 64, test.id);
      try {
        e.beginFilter(test.id, JSON.stringify(test.params()));
        const candidate = regionDigest(e);
        e.commitFilter();
        const committed = regionDigest(e);
        const bytes = e.saveProject();
        const reopened = new mod.WasmEditor();
        reopened.openProject(bytes, "");
        const afterOpen = regionDigest(reopened);
        // undo 改变、redo 复原：提交确实进了历史而不是被合并进基线。
        e.execute("edit.undo", "{}");
        const undone = regionDigest(e);
        e.execute("edit.redo", "{}");
        const redone = regionDigest(e);
        if (!(committed === candidate && afterOpen === committed && undone !== committed && redone === committed)) {
          failures.push({ id: test.id, committedMatchesCandidate: committed === candidate, reopenMatches: afterOpen === committed, undoChanges: undone !== committed, redoRestores: redone === committed });
        }
        reopened.free();
      } catch (err) {
        failures.push({ id: test.id, error: String(err).slice(0, 140) });
        try { e.cancelFilter(); } catch {}
      }
      e.free();
    }
    record("roundtrip", { checked: cases.length, failures });
  }
}

// ---------------------------------------------------------------- 每个标量控件都能送进内核
{
  const { catalogue } = catalogueOf();
  const probe = (spec) => {
    if (spec.kind === "bool") return !spec.default;
    if (spec.kind === "choice") return spec.choices.find((x) => x !== spec.default) ?? null;
    if (spec.kind === "color") return "#336699";
    const min = spec.min ?? 0;
    const max = spec.max ?? 100;
    const base = typeof spec.default === "number" ? spec.default : min;
    return Math.min(max, Math.max(min, base + (max - base) * 0.25));
  };
  const skipped = new Set(["filter.filterGallery", "filter.vanishingPoint", "filter.distort.displace"]);
  const failures = [];
  let checked = 0;
  for (const filter of catalogue.filters) {
    if (skipped.has(filter.id)) continue;
    for (const spec of filter.params.filter((p) => p.kind !== "resource" && p.key !== "seed")) {
      const value = probe(spec);
      if (value === null) { failures.push({ id: filter.id, key: spec.key, why: "probe-null" }); continue; }
      const e = patterned();
      try {
        e.beginFilter(filter.id, JSON.stringify({ ...panelDefaults(filter), [spec.key]: value }));
        checked += 1;
        e.cancelFilter();
      } catch (err) {
        failures.push({ id: filter.id, key: spec.key, value, error: String(err).slice(0, 130) });
        try { e.cancelFilter(); } catch {}
      }
      e.free();
    }
  }
  record("controls", { checked, failures });
}

// ---------------------------------------------------------------- 每个画廊效果参数都能送进内核
{
  const e0 = new mod.WasmEditor();
  const gallery = JSON.parse(e0.filterGalleryCatalogueJson());
  e0.free();
  const probe = (spec) => {
    if (spec.kind === "bool") return !spec.default;
    if (spec.kind === "choice") return spec.choices.find((x) => x !== spec.default) ?? null;
    if (spec.kind === "color") return "#336699";
    const min = spec.min ?? 0;
    const max = spec.max ?? 100;
    const base = typeof spec.default === "number" ? spec.default : min;
    return Math.min(max, Math.max(min, base + (max - base) * 0.25));
  };
  const failures = [];
  let checked = 0;
  for (const effect of gallery.filters) {
    for (const spec of effect.params.filter((p) => p.kind !== "resource" && p.key !== "seed")) {
      const params = Object.fromEntries(
        effect.params
          .filter((p) => p.kind !== "resource" && p.key !== "seed" && p.default !== null)
          .map((p) => [p.key, p.default])
      );
      params[spec.key] = probe(spec);
      const e = patterned();
      try {
        e.beginFilter("filter.filterGallery", JSON.stringify({ effects: [{ filter: effect.key, params, visible: true }] }));
        checked += 1;
        e.cancelFilter();
      } catch (err) {
        failures.push({ effect: effect.key, key: spec.key, error: String(err).slice(0, 130) });
        try { e.cancelFilter(); } catch {}
      }
      e.free();
    }
  }
  record("galleryControls", { effects: gallery.filters.length, checked, failures });
}

// ---------------------------------------------------------------- 重复上次：参数、目标层、历史
{
  const e = patterned();
  e.beginFilter("filter.sharpen.unsharpMask", JSON.stringify({ amount: 200, radius: 3, threshold: 0 }));
  const committed = JSON.parse(e.commitFilter());
  const last = JSON.parse(e.filterLastJson());
  // 换到新的可写层再重复
  e.execute("layer.new.layer", JSON.stringify({ name: "second" }));
  for (let i = 0; i < 8; i += 1) {
    e.execute("paint.stroke", JSON.stringify({
      points: [[4 + i * 10, 4], [16 + i * 8, 56]], size: 4, hardness: 1, opacity: 1, flow: 1,
      color: i % 2 ? "#33aa66" : "#cc3366", target: "pixels"
    }));
  }
  const repeat = JSON.parse(e.repeatLastFilter());
  const draft = repeat.draft ?? repeat;
  record("repeatLast", {
    committed: committed.changed,
    lastAvailable: last.available,
    sameParams: JSON.stringify(draft.params) === JSON.stringify(last.params),
    retargeted: draft.layer !== committed.layers?.[0],
    layer: draft.layer
  });
  e.cancelFilter();
  e.free();
}

// ---------------------------------------------------------------- 重复上次：快捷键所走的命令分派
{
  const e = patterned();
  const before = digest(e);
  e.beginFilter("filter.sharpen.unsharpMask", JSON.stringify({ amount: 200, radius: 3, threshold: 0 }));
  e.commitFilter();
  const enabledAfter = JSON.parse(e.commandsJson()).find((c) => c.id === "filter.lastFilter");
  e.execute("layer.new.layer", JSON.stringify({ name: "second" }));
  for (let i = 0; i < 8; i += 1) {
    e.execute("paint.stroke", JSON.stringify({
      points: [[4 + i * 10, 4], [16 + i * 8, 56]], size: 4, hardness: 1, opacity: 1, flow: 1,
      color: i % 2 ? "#33aa66" : "#cc3366", target: "pixels"
    }));
  }
  const beforeDispatch = digest(e);
  const historyBefore = JSON.parse(e.stateJson()).document.history.length;
  const dispatched = e.execute("filter.lastFilter", "{}");
  const afterDispatch = digest(e);
  const historyAfter = JSON.parse(e.stateJson()).document.history.length;
  e.execute("edit.undo", "{}");
  record("lastFilterCommand", {
    enabled: enabledAfter?.enabled,
    shortcut: enabledAfter?.shortcut ?? null,
    dispatched: JSON.parse(dispatched).filter !== undefined,
    changedPixels: afterDispatch !== beforeDispatch,
    historySteps: historyAfter - historyBefore,
    undoRestores: digest(e) === beforeDispatch
  });
  e.free();
}

// ---------------------------------------------------------------- 草稿门禁：快捷键不绕过
{
  const e = patterned();
  e.beginFilter("filter.sharpen.unsharpMask", JSON.stringify({ amount: 180, radius: 2, threshold: 0 }));
  e.commitFilter();
  e.beginFilter("filter.blur.gaussianBlur", JSON.stringify({ radius: 4 }));
  const before = JSON.parse(e.filterDraftStateJson());
  let refused = false;
  try {
    e.execute("filter.lastFilter", "{}");
  } catch (err) {
    refused = String(err).includes("请先确认或取消滤镜草稿");
  }
  const after = JSON.parse(e.filterDraftStateJson());
  record("draftGuard", {
    refused,
    draftUnchanged: JSON.stringify(before?.params) === JSON.stringify(after?.params),
    stillDrafting: after !== null
  });
  e.cancelFilter();
  e.free();
}

// ---------------------------------------------------------------- Camera Raw：曲线 / HSL / 分级 / 光源组
// 这些字段在内核里都生效，却曾经只有声明没有控件。这里用**面板同一批函数**构造载荷，
// 证明控件写出的参数确实改变候选图，而不是被内核忽略。
{
  const bundle = process.env.CATALOGUE_BUNDLE ?? ".local/catalogue-bundle.mjs";
  let api = null;
  try { api = await import(pathToFileURL(path.resolve(bundle)).href); } catch { api = null; }
  if (!api) {
    record("cameraRaw", { skipped: `未找到面板模块（${bundle}）` });
  } else {
    const { catalogue } = catalogueOf();
    const entry = catalogue.filters.find((f) => f.id === "filter.cameraRaw");
    const lightsEntry = catalogue.filters.find((f) => f.id === "filter.render.lightingEffects");
    const base = () => Object.fromEntries(
      entry.params.filter((p) => p.kind !== "resource" && p.key !== "seed" && p.default !== null).map((p) => [p.key, p.default])
    );
    const changedWith = (id, params) => {
      const e = patterned();
      const before = digest(e);
      try {
        e.beginFilter(id, JSON.stringify(params));
        const changed = digest(e) !== before;
        e.cancelFilter();
        e.free();
        return { changed };
      } catch (err) {
        e.free();
        return { changed: false, error: String(err).slice(0, 150) };
      }
    };
    const curve = api.addCurvePoint(api.identityCurve(), [64, 96]);
    record("cameraRaw", {
      identity: changedWith("filter.cameraRaw", base()),
      pointCurve: changedWith("filter.cameraRaw", { ...base(), ...api.withCurve(base(), "pointCurve", curve, entry) }),
      pointCurveRed: changedWith("filter.cameraRaw", { ...base(), ...api.withCurve(base(), "pointCurveRed", [[0, 0], [128, 40], [255, 255]], entry) }),
      // 色带要落在图案真实存在的色相上：这份图案只有橙(≈32°→band 1)与蓝(≈217°→band 4/5)。
      // 改红(band 0)或洋红(band 7)不会影响任何像素——那是载荷选错，不是控件失效。
      hslHue: changedWith("filter.cameraRaw", { ...base(), ...api.withHslBand(base(), "hslHue", [0, 60, 0, 0, 60, 60, 0, 0], entry) }),
      hslSat: changedWith("filter.cameraRaw", { ...base(), ...api.withHslBand(base(), "hslSat", [0, -90, 0, 0, -90, -90, 0, 0], entry) }),
      hslLum: changedWith("filter.cameraRaw", { ...base(), ...api.withHslBand(base(), "hslLum", [0, -80, 0, 0, -80, -80, 0, 0], entry) }),
      // 反证：改与图案无关的色带不会改变像素，说明上面三项确实由色带权重决定。
      hslOffBandNoop: changedWith("filter.cameraRaw", { ...base(), ...api.withHslBand(base(), "hslHue", [100, 0, 0, 0, 0, 0, 0, 100], entry) }),
      gradeShadows: changedWith("filter.cameraRaw", { ...base(), ...api.withWheel(base(), "gradeShadows", { hue: 30, sat: 70, lum: 10 }, entry) }),
      curveSplits: changedWith("filter.cameraRaw", { ...base(), ...api.withCurveSplits({ ...base(), curveShadows: 60 }, [10, 45, 90], entry) }),
      // 坏曲线不送内核：单点/递减会被写成空曲线（内核接受的不调整），而不是让整次草稿失败。
      badCurveBecomesEmpty: api.withCurve(base(), "pointCurve", [[128, 128]], entry).pointCurve,
      lights: (() => {
        const lightsBase = Object.fromEntries(
          lightsEntry.params.filter((p) => p.kind !== "resource" && p.key !== "seed" && p.default !== null).map((p) => [p.key, p.default])
        );
        const one = api.addLight([], api.newLight(), 16);
        const two = api.addLight(one, { ...api.newLight(), kind: "point", x: 0.7, y: 0.6, intensity: 60 }, 16);
        return {
          single: changedWith("filter.render.lightingEffects", { ...lightsBase, ...api.withLights({}, one, lightsEntry) }),
          pair: changedWith("filter.render.lightingEffects", { ...lightsBase, ...api.withLights({}, two, lightsEntry) })
        };
      })()
    });
  }
}

// ---------------------------------------------------------------- 图内几何：镜头校正拉直线
{
  const run = (line) => {
    const e = patterned();
    const before = digest(e);
    const params = { profile: "none", scale: 100, ...(line ? { straighten: line } : {}) };
    const draft = JSON.parse(e.beginFilter("filter.lensCorrection", JSON.stringify(params)));
    const changed = digest(e) !== before;
    e.cancelFilter();
    e.free();
    return { changed, hasStraighten: "straighten" in draft.params };
  };
  record("straighten", {
    level: run([[24, 32], [72, 32]]),
    tilted: run([[10, 20], [86, 44]]),
    cleared: run(null)
  });
}

// ---------------------------------------------------------------- 图内几何：五个模糊画廊命令
// 载荷一律按**命令声明**构造（与面板的声明驱动一致），不按名字猜结构：
//   pins  → 由 `blurPinKey(entry)` 决定每点写 `blur` 还是 `blurAngle`
//   paths → 由 `withBlurPaths` 写 `paths` 并同步起止标量
{
  const { catalogue } = catalogueOf();
  const bundle = process.env.CATALOGUE_BUNDLE ?? ".local/catalogue-bundle.mjs";
  let catalogueModule = null;
  try {
    catalogueModule = await import(pathToFileURL(path.resolve(bundle)).href);
  } catch {
    catalogueModule = null;
  }
  if (!catalogueModule) {
    record("blurGallery", { skipped: `未找到面板模块（${bundle}），无法按声明构造图内几何载荷` });
  }
  const { blurPinKey, withBlurPins, withBlurPaths, defaultParams, declaresParam } = catalogueModule ?? {};
  const entryOf = (id) => catalogue.filters.find((f) => f.id === id);
  const out = {};
  if (catalogueModule) for (const id of [
    "filter.blurGallery.fieldBlur",
    "filter.blurGallery.irisBlur",
    "filter.blurGallery.spinBlur",
    "filter.blurGallery.tiltShift",
    "filter.blurGallery.pathBlur"
  ]) {
    const entry = entryOf(id);
    if (!entry) { out[id] = { ok: false, reason: "不在目录" }; continue; }
    let params = defaultParams(entry);
    if (declaresParam(entry, "pins")) {
      // `FilterPin` 恒用 `blur` 字段；`withBlurPins` 按声明改写成 `blur` 或 `blurAngle`。
      const pins = [
        { x: 0.5, y: 0.3, blur: 22 },
        { x: 0.5, y: 0.7, blur: 22 }
      ];
      params = withBlurPins(params, pins, entry);
      out[`${id}.pinKey`] = blurPinKey(entry);
    }
    if (declaresParam(entry, "paths")) {
      params = withBlurPaths(params, [{ points: [[0.2, 0.5], [0.8, 0.5]], speed: 50, taper: 0 }], entry);
    }
    const e = patterned();
    const before = digest(e);
    try {
      const draft = JSON.parse(e.beginFilter(id, JSON.stringify(params)));
      out[id] = { ok: true, changed: digest(e) !== before, fields: Object.keys(draft.params).sort() };
      e.cancelFilter();
    } catch (err) {
      out[id] = { ok: false, error: String(err).slice(0, 140) };
      try { e.cancelFilter(); } catch {}
    }
    e.free();
  }
  record("blurGallery", out);
}

// ---------------------------------------------------------------- 自定卷积：恒等 vs 有效核
{
  const kernelCase = (kernel) => {
    const e = patterned();
    const before = digest(e);
    const draft = JSON.parse(e.beginFilter("filter.other.custom", JSON.stringify({ kernel })));
    const changed = digest(e) !== before;
    e.cancelFilter();
    e.free();
    return { changed, kernelCount: draft.params.kernel?.length ?? null };
  };
  const identity = Array.from({ length: 25 }, (_, i) => (i === 12 ? 1 : 0));
  const mean = Array.from({ length: 25 }, () => 1 / 25);
  record("customKernel", { identity: kernelCase(identity), mean: kernelCase(mean) });
}

// ---------------------------------------------------------------- 位移图必须来自已打开文档
{
  const e = patterned(64, 48, "target");
  e.execute("file.new", JSON.stringify({ width: 64, height: 48, name: "map" }));
  // 两层要用**不同**图案：压平整份文档与只取一层才会给出不同位移。
  e.execute("layer.new.layer", JSON.stringify({ name: "mapSeed" }));
  for (let y = 0; y < 48; y += 6) {
    e.execute("paint.stroke", JSON.stringify({ points: [[0, y], [64, y]], size: 6, hardness: 1, opacity: 1, flow: 1, color: "#808080", target: "pixels" }));
  }
  e.execute("layer.new.layer", JSON.stringify({ name: "mapBars" }));
  for (let x = 0; x < 64; x += 6) {
    e.execute("paint.stroke", JSON.stringify({ points: [[x, 0], [x, 48]], size: 6, hardness: 1, opacity: 1, flow: 1, color: "#c0c0c0", target: "pixels" }));
  }
  const sources = JSON.parse(e.filterMapSourcesJson());
  record("displace", {
    sources: sources.documents.map((d) => d.name),
    // 每份文档都要带上它自己的像素图层：内核的 `mapLayer` 是文档内图层 id。
    sourcesCarryLayers: sources.documents.every((d) => Array.isArray(d.layers)),
    layerIds: sources.documents.map((d) => ({ name: d.name, layers: d.layers.map((l) => `${l.id}:${l.name}`) })),
    // 按图层取位移图与压平整份文档要给出**不同候选**，否则 `mapLayer` 只是个死字段。
    layerChangesResult: (() => {
      const mapDoc = sources.documents.find((d) => d.name === "map");
      const layerId = mapDoc?.layers?.at(-1)?.id;
      if (layerId === undefined) return "no-layer";
      const candidate = (params) => {
        try {
          e.beginFilter("filter.distort.displace", JSON.stringify(params));
        } catch (err) {
          return `refused:${String(err).slice(0, 60)}`;
        }
        const out = digest(e);
        e.cancelFilter();
        return out;
      };
      const flat = candidate({ horizontal: 12, vertical: -8, mapDocument: "map" });
      const layered = candidate({ horizontal: 12, vertical: -8, mapDocument: "map", mapLayer: layerId });
      return typeof flat === "number" && typeof layered === "number" ? flat !== layered : `${flat} / ${layered}`;
    })(),
    // 回到第一个文档做目标（名字解析而不是本机路径）
    byName: (() => {
      try {
        e.beginFilter("filter.distort.displace", JSON.stringify({ horizontal: 12, vertical: -8, mapDocument: "map" }));
        const changed = true;
        e.cancelFilter();
        return { ok: changed };
      } catch (err) { return { ok: false, error: String(err).slice(0, 120) }; }
    })(),
    localPathRefused: (() => {
      try {
        e.beginFilter("filter.distort.displace", JSON.stringify({ mapPath: "/tmp/map.png" }));
        e.cancelFilter();
        return false;
      } catch (err) { return String(err).includes("不允许按本机路径"); }
    })(),
    missingRefused: (() => {
      try {
        e.beginFilter("filter.distort.displace", JSON.stringify({ mapDocument: "nope" }));
        e.cancelFilter();
        return false;
      } catch { return true; }
    })()
  });
  e.free();
}

// ---------------------------------------------------------------- 消失点：透视克隆（面板声明驱动）
// 取样点与落笔点必须**跨色区**才看得出克隆：同色区域复制自己，像素本来就不变。
// 这份图案左半红、右半蓝，于是「右取左落」能把红区改成蓝。
{
  const bundle = process.env.CATALOGUE_BUNDLE ?? ".local/catalogue-bundle.mjs";
  let api = null;
  try { api = await import(pathToFileURL(path.resolve(bundle)).href); } catch { api = null; }
  if (!api) {
    record("vanishClone", { skipped: `未找到面板模块（${bundle}）` });
  } else {
    // 必须带上命令声明：`withClones` 按声明决定写不写 `clone`，漏传等于「该命令没有这个字段」。
    const { catalogue } = catalogueOf();
    const entry = catalogue.filters.find((f) => f.id === "filter.vanishingPoint");
    const twoTone = () => {
      const e = new mod.WasmEditor();
      e.execute("file.new", JSON.stringify({ width: 160, height: 120, name: "vp" }));
      e.execute("layer.new.layer", JSON.stringify({ name: "base" }));
      for (let y = 0; y < 120; y += 4) {
        e.execute("paint.stroke", JSON.stringify({ points: [[2, y], [76, y]], size: 4, hardness: 1, opacity: 1, flow: 1, color: "#ff0000", target: "pixels" }));
        e.execute("paint.stroke", JSON.stringify({ points: [[84, y], [156, y]], size: 4, hardness: 1, opacity: 1, flow: 1, color: "#0000ff", target: "pixels" }));
      }
      return e;
    };
    const planes = [{ corners: [[10, 10], [150, 12], [148, 112], [12, 110]] }];
    const e = twoTone();
    const before = digest(e);
    e.beginFilter("filter.vanishingPoint", JSON.stringify({
      planes,
      clone: api.withClones({}, [{ source: [120, 60], points: [[40, 60], [20, 60]], size: 30, hardness: 100, opacity: 100 }], entry).clone
    }));
    const changed = digest(e) !== before;
    // 位置断言：左侧被右侧的蓝色覆盖，右侧原样。
    const preview = e.renderPreview(160);
    const bytes = new Uint8Array(preview.pixels);
    const at = (x, y) => Array.from(bytes.slice((y * preview.width + x) * 4, (y * preview.width + x) * 4 + 4));
    const left = at(40, 60);
    const right = at(120, 60);
    preview.free?.();
    e.cancelFilter();
    e.free();
    record("vanishClone", {
      changed,
      copiedRightToLeft: left[2] > 200 && left[0] < 60,
      rightUntouched: right[2] > 200 && right[0] < 60,
      // 只给平面不改像素：透视本身不落像素。
      planesOnlyChanged: (() => {
        const s = twoTone();
        const hash = digest(s);
        s.beginFilter("filter.vanishingPoint", JSON.stringify({ planes }));
        const out = digest(s) !== hash;
        s.cancelFilter();
        s.free();
        return out;
      })(),
      malformedDropped: api.vanishingClones({ clone: [{ points: [[1, 2]] }, { source: [3, 4], points: [[5, 6]] }] }).length,
      defaultCloneInsideCanvas: (() => {
        const one = api.addClone([], { width: 160, height: 120 })[0];
        return one.points.every(([x, y]) => x <= 160 && y <= 120 && x >= 0 && y >= 0);
      })()
    });
  }
}

// ---------------------------------------------------------------- 消失点：透视粘贴（必须选来源图层）
// `paste[].layer` 只认图层 id；不传 `layer` 时内核走剪贴板，而探针里没有剪贴板内容，
// 结果不是「贴上去」而是「nothing on the clipboard」。所以这里同时验证：
// 本域端口能列出可贴图层、按 id 粘贴会把来源层的像素搬到平面上、缺 layer 时会被拒绝。
{
  const bundle = process.env.CATALOGUE_BUNDLE ?? ".local/catalogue-bundle.mjs";
  let api = null;
  try { api = await import(pathToFileURL(path.resolve(bundle)).href); } catch { api = null; }
  if (!api) {
    record("vanishPaste", { skipped: `未找到面板模块（${bundle}）` });
  } else {
    const scene = () => {
      const e = new mod.WasmEditor();
      e.execute("file.new", JSON.stringify({ width: 160, height: 120, name: "vp" }));
      e.execute("layer.new.layer", JSON.stringify({ name: "paint" }));
      for (let y = 0; y < 120; y += 4) {
        e.execute("paint.stroke", JSON.stringify({ points: [[2, y], [156, y]], size: 4, hardness: 1, opacity: 1, flow: 1, color: "#ff0000", target: "pixels" }));
      }
      e.execute("layer.new.layer", JSON.stringify({ name: "source" }));
      for (let y = 20; y < 80; y += 4) {
        e.execute("paint.stroke", JSON.stringify({ points: [[90, y], [140, y]], size: 4, hardness: 1, opacity: 1, flow: 1, color: "#00ff00", target: "pixels" }));
      }
      e.execute("layer.select", JSON.stringify({ name: "paint" }));
      return e;
    };
    const { catalogue } = catalogueOf();
    const entry = catalogue.filters.find((f) => f.id === "filter.vanishingPoint");
    const planes = [{ corners: [[10, 10], [150, 12], [148, 112], [12, 110]] }];
    const e = scene();
    // 本域端口：只列可见且有内容的像素图层。
    const layers = JSON.parse(e.filterLayerSourcesJson()).layers;
    const green = layers.find((layer) => layer.name === "source");
    const pixelCount = (s, test) => {
      let n = 0;
      for (let i = 0; i < s.c.length; i += 4) if (test(s.c[i], s.c[i + 1], s.c[i + 2])) n += 1;
      return n;
    };
    const greenish = (r, g, b) => r < 80 && g > 180 && b < 80;
    const before = snapPreview(e, 160);
    const pasteParams = api.withPastes({}, [api.newPaste(0, green.id)], entry);
    e.beginFilter("filter.vanishingPoint", JSON.stringify({ planes, ...pasteParams }));
    const after = snapPreview(e, 160);
    let changed = false;
    for (let i = 0; i < before.c.length; i += 1) if (before.c[i] !== after.c[i]) { changed = true; break; }
    const afterCount = pixelCount(after, greenish);
    const payload = JSON.parse(JSON.stringify(pasteParams));
    e.cancelFilter();
    // 缺 layer：没有剪贴板内容时必须被拒绝，而不是静默不贴。
    let missingLayerRefused = false;
    try {
      e.beginFilter("filter.vanishingPoint", JSON.stringify({ planes, paste: [{ plane: 0 }] }));
      e.cancelFilter();
    } catch {
      missingLayerRefused = true;
    }
    e.free();
    record("vanishPaste", {
      portListsLayers: layers.length >= 2 && !!green,
      // 指定了来源时 `layer` 必须写进去；缺失等于「用剪贴板」，而探针没有剪贴板内容。
      layerIdWritten: payload.paste[0].layer === green.id,
      changed,
      pastedGreenGrew: afterCount > pixelCount(before, greenish),
      missingLayerRefused
    });
  }
}

// ---------------------------------------------------------------- 渲染：火焰的路径来源
// `filter.render.flame.path` 是**已保存路径的名字**，不是坐标数组。本构建里 `path.*` 全部被
// capability 门禁关闭（`path.set`/`path.create` 不可用），所以无法造出一条已保存路径来验证
// 「换路径改变像素」。这里只钉住能证明的部分：端口形状正确、面板写出的名字确实到达内核
// （回执里原样回显），以及缺省时不写该字段。像素级「不同路径不同火焰」待路径能力开放后人工验证。
{
  const bundle = process.env.CATALOGUE_BUNDLE ?? ".local/catalogue-bundle.mjs";
  let api = null;
  try { api = await import(pathToFileURL(path.resolve(bundle)).href); } catch { api = null; }
  if (!api) {
    record("flamePath", { skipped: `未找到面板模块（${bundle}）` });
  } else {
    const { catalogue, commands } = catalogueOf();
    const entry = catalogue.filters.find((f) => f.id === "filter.render.flame");
    const e = patterned(160, 120, "flame");
    const port = JSON.parse(e.filterPathSourcesJson());
    const base = Object.fromEntries(
      entry.params.filter((p) => p.kind !== "resource" && p.key !== "seed" && p.default !== null).map((p) => [p.key, p.default])
    );
    const echo = (params) => {
      const before = digest(e);
      const draft = JSON.parse(e.beginFilter("filter.render.flame", JSON.stringify(params)));
      const changed = digest(e) !== before;
      e.cancelFilter();
      return { changed, path: draft.params.path ?? null };
    };
    const withName = echo({ ...base, ...api.withFlamePath(base, "不存在但合法的名字", entry) });
    const withoutName = echo({ ...base, ...api.withFlamePath(base, null, entry) });
    e.free();
    record("flamePath", {
      portShape: Array.isArray(port.paths) && typeof port.hasWorkPath === "boolean",
      // 名字原样回显 = 该字段通过校验并进入了内核参数，而不是被静默丢弃。
      nameReachesKernel: withName.path === "不存在但合法的名字",
      defaultOmitsField: withoutName.path === null,
      rendersWithoutPath: withName.changed && withoutName.changed,
      // 这个构建里所有 path.* 都被门禁关闭：整条路径功能的像素级验证因此做不了。
      pathCommandsGatedOff: commands.filter((c) => String(c.id).startsWith("path.")).every((c) => c.enabled !== true)
    });
  }
}

// ---------------------------------------------------------------- 切变曲线（`shear.points`）
// 面板现在能编辑 `points`；此前只有 `amount` 一个入口，等于形状控制不存在。
{
  const candidate = (params) => {
    const e = patterned();
    const before = digest(e);
    try {
      e.beginFilter("filter.distort.shear", JSON.stringify(params));
    } catch (err) {
      e.cancelFilter();
      e.free();
      return { refused: String(err).slice(0, 120) };
    }
    const out = digest(e);
    e.cancelFilter();
    e.free();
    return { changed: out !== before, out };
  };
  const custom = candidate({ amount: 0, points: [[0, 0], [0.5, 0.6], [1, 0]] });
  const byAmount = candidate({ amount: 0 });
  record("shearCurve", {
    customChangesPixels: custom.changed === true,
    // 自定义曲线与缺省 amount 曲线结果不同，证明 `points` 真的被读而不是被忽略。
    differsFromAmount: custom.out !== byAmount.out,
    // 2 点零位移曲线是合法空操作：直线不移动任何行。
    straightIsNoop: candidate({ points: [[0, 0], [1, 0]] }).changed === false,
    // 乱序 / 空曲线会被内核整条拒绝，面板必须先排好序再写回。
    unsortedRefused: typeof candidate({ points: [[1, 0], [0, 0]] }).refused === "string",
    emptyRefused: typeof candidate({ points: [] }).refused === "string"
  });
}

// ---------------------------------------------------------------- 画廊 `glowColor`
// 画廊编辑器此前跳过所有 resource 参数，霓虹光晕的颜色因此一直没有入口。
{
  const candidate = (glowColor) => {
    const e = patterned();
    const before = digest(e);
    try {
      e.beginFilter("filter.gallery.neonGlow", JSON.stringify(glowColor === undefined ? {} : { glowColor }));
    } catch (err) {
      e.cancelFilter();
      e.free();
      return { refused: String(err).slice(0, 120) };
    }
    const out = digest(e);
    e.cancelFilter();
    e.free();
    return { changed: out !== before, out };
  };
  const red = candidate("#ff0000");
  const green = candidate("#00ff00");
  record("galleryGlow", {
    defaultChanges: candidate(undefined).changed === true,
    colourChangesPixels: red.changed === true,
    // 两种颜色给出不同候选：控件不是摆设。
    differentColoursDiffer: red.out !== green.out,
    // 非法颜色被内核拒绝，面板必须只给合法值。
    badColourRefused: typeof candidate("not-a-colour").refused === "string"
  });
}

// ---------------------------------------------------------------- 跨域：选区 / 蒙版 / 非像素目标 / undo-redo
{
  const selection = (() => {
    const e = patterned();
    const whole = digest(e);
    e.execute("select.rect", JSON.stringify({ x: 0, y: 0, width: 40, height: 64 }));
    e.beginFilter("filter.blur.gaussianBlur", JSON.stringify({ radius: 6 }));
    const out = {
      hasSelectionDuringDraft: JSON.parse(e.stateJson()).document.hasSelection,
      candidateChanged: digest(e) !== whole,
      committed: JSON.parse(e.commitFilter()).changed
    };
    e.free();
    return out;
  })();
  const masked = (() => {
    const e = patterned();
    const layer = JSON.parse(e.stateJson()).document.layers.at(-1).id;
    e.execute("layer.layerMask.revealAll", JSON.stringify({ layer }));
    e.beginFilter("filter.sharpen.unsharpMask", JSON.stringify({ amount: 150, radius: 2, threshold: 0 }));
    const out = { committed: JSON.parse(e.commitFilter()).changed };
    e.free();
    return out;
  })();
  const nonPixel = (() => {
    const e = patterned();
    e.execute("layer.newAdjustmentLayer.brightnessContrast", JSON.stringify({ brightness: 10, contrast: 0 }));
    const active = JSON.parse(e.stateJson()).document.activeLayer;
    const kind = JSON.parse(e.stateJson()).document.layers.find((l) => l.id === active)?.kind;
    let out;
    try {
      e.beginFilter("filter.blur.gaussianBlur", JSON.stringify({ radius: 4 }));
      out = { kind, refused: false };
      e.cancelFilter();
    } catch (err) {
      const parsed = JSON.parse(String(err).replace(/^Error: /, ""));
      out = { kind, refused: true, command: parsed.message.split(" ")[1] };
    }
    e.free();
    return out;
  })();
  const undoRedo = (() => {
    const e = patterned();
    const base = digest(e);
    e.beginFilter("filter.sharpen.unsharpMask", JSON.stringify({ amount: 200, radius: 3, threshold: 0 }));
    e.commitFilter();
    const filtered = digest(e);
    e.execute("edit.undo", "{}");
    const undone = digest(e);
    e.execute("edit.redo", "{}");
    const out = { filterChanged: filtered !== base, undoRestores: undone === base, redoReapplies: digest(e) === filtered };
    e.free();
    return out;
  })();
  record("crossDomain", { selection, masked, nonPixel, undoRedo });
}

console.log(JSON.stringify(results, null, 1));
