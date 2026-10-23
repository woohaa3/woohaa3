import { expect, it } from "vitest";
import { createHandle } from "./wasm-handle.js";
import type { FeatureHandleContext } from "../contracts.js";
import type { EditorInstance } from "../../editor-wasm.js";

/**
 * 旧运行时门禁。
 *
 * spec 明确要求「加载旧运行时、缺宿主端口、未知能力或超预算内容 → 拒绝相关写入，不静默丢数据」。
 * `wasm-handle.ts` 里每个入口都先 `missing(...)` 再调用，但此前**没有任何回归**证明这条路径真的
 * 返回 `capability-unavailable` 而不是抛 `TypeError`——而"抛错"与"拒绝"对界面是两回事：
 * 前者会把面板打崩，后者会给出可读原因。
 *
 * 这里用只实现 P0 契约的假运行时（U17–U24 的导出全部缺失）逐条走一遍。
 */

/** 只实现 P0 基线导出的旧运行时：U17–U24 的新导出一个都没有。 */
function legacyInstance(): EditorInstance {
  return {
    beginSelectionModify: () => "{}",
    updateSelectionModify: () => "{}",
    commitSelectionModify: () => "{}",
    cancelSelectionModify: () => undefined,
    prepareRefineEdge: () => "{}",
    beginSelectionTransform: () => undefined
  } as unknown as EditorInstance;
}

function context(instance: EditorInstance): FeatureHandleContext {
  return {
    instance,
    // 与真实适配同样的语义：调用成功返回 ok，抛错则归一成失败而不是冒泡。
    call: <T,>(run: (instance: EditorInstance) => T) => {
      try {
        return { ok: true as const, value: run(instance) };
      } catch (error) {
        return { ok: false as const, code: "command-failed", message: String(error) };
      }
    }
  };
}

it("旧运行时缺 U17–U24 导出时逐条拒绝，不抛 TypeError", () => {
  const handle = createHandle(() => context(legacyInstance()));
  // 每项都是"有实现、但运行时没有对应导出"：必须返回明确失败，不能命中脆弱的可选调用。
  const calls: [string, () => unknown][] = [
    ["selectLine", () => handle.selectLine({ x: 0, y: 0, line: "row" })],
    ["beginMagneticLasso", () => handle.beginMagneticLasso({ points: [] })],
    ["updateMagneticLasso", () => handle.updateMagneticLasso({ points: [] })],
    ["saveNamedSelection", () => handle.saveNamedSelection({ name: "a" })],
    ["loadNamedSelection", () => handle.loadNamedSelection({ name: "a" })],
    ["beginColorGrow", () => handle.beginColorGrow(false, {})],
    ["updateColorGrow", () => handle.updateColorGrow({})],
    ["beginQuickMask", () => handle.beginQuickMask()],
    ["paintQuickMask", () => handle.paintQuickMask({ points: [[0, 0]] })],
    ["exitQuickMask", () => handle.exitQuickMask(false)],
    ["beginSmartSelect", () => handle.beginSmartSelect("object", {})],
    ["beginColorRange", () => handle.beginColorRange({})],
    ["updateColorRange", () => handle.updateColorRange({})],
    ["beginRefineEdge", () => handle.beginRefineEdge({})],
    ["updateRefineEdge", () => handle.updateRefineEdge({})],
    ["editLayerMask", () => handle.editLayerMask({ density: 50 })],
    ["layerMaskProperties", () => handle.layerMaskProperties(1)],
    ["viewLayerMask", () => handle.viewLayerMask({ mode: "gray" })],
    ["selectionDraftState", () => handle.selectionDraftState()],
    ["selectionDraftOutline", () => handle.selectionDraftOutline()],
    ["commitSelectionDraft", () => handle.commitSelectionDraft()],
    ["cancelSelectionDraft", () => handle.cancelSelectionDraft()]
  ];
  for (const [name, call] of calls) {
    let result: unknown;
    // 关键：调用本身不能抛（面板不会 try/catch），必须是返回值形式的拒绝。
    expect(() => { result = call(); }, name).not.toThrow();
    expect(result, name).toMatchObject({ ok: false, code: "capability-unavailable" });
    // 文案要点出缺的是哪个导出，供用户/日志定位"需要更新内核"。
    expect((result as { message: string }).message).toContain("请更新编辑内核");
  }
});

it("同一批入口在新运行时上正常调用（门禁不误伤已装能力）", () => {
  const seen: string[] = [];
  const modern = new Proxy({} as Record<string, unknown>, {
    get: (_target, key: string) => {
      // 每个导出都返回合法 JSON，便于断言"确实调到了运行时"。
      return (...args: unknown[]) => { seen.push(args.length ? `${key}(${args.join(",")})` : key); return "{}"; };
    }
  }) as unknown as EditorInstance;
  const handle = createHandle(() => context(modern));
  expect(handle.selectLine({ x: 3, y: 4, line: "row" })).toMatchObject({ ok: true });
  expect(handle.beginQuickMask()).toMatchObject({ ok: true });
  expect(handle.exitQuickMask(true)).toMatchObject({ ok: true });
  expect(handle.selectionDraftState()).toMatchObject({ ok: true });
  // 参数真的透传到导出（否则"接通"只是表面）。
  expect(seen.some((entry) => entry.startsWith("selectLine("))).toBe(true);
  expect(seen).toContain("exitQuickMask(true)");
});
