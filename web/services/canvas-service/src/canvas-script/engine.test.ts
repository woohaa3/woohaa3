/**
 * Canvas Script 受限执行与语义 recorder 测试
 * （change: 2026-10-13-add-canvas-script-authoring，任务 2.1–2.5）。
 *
 * 覆盖：六类节点、连线/移动/提示词/删除、placement/if、伪造/失效 handle、未知字段拒绝、
 * 宿主逃逸与动态执行阻断、预算（循环/超时/OOM/操作数/并发）、双 realm 确定性与阶段化诊断。
 *
 * 这些是**非渲染**检查：不采集帧率/GPU/截图，只验证隔离执行与语义记录行为。
 */
import { describe, expect, it } from "vitest";
import { CANVAS_SCRIPT_GUIDE_EXAMPLE, canvasScriptSubmissionHash } from "@woohaa3/contracts";
import { CanvasScriptRecorder } from "./recorder.js";
import { CanvasScriptConcurrencyGate } from "./availability.js";
import { canvasScriptPrelude } from "./prelude.js";

const KINDS = ["text", "image", "model", "video", "audio"] as const;

function recorder(): CanvasScriptRecorder {
  return new CanvasScriptRecorder();
}

async function record(source: string, overrides: Partial<Parameters<CanvasScriptRecorder["record"]>[0]> = {}) {
  return recorder().record({
    source,
    nodeKinds: KINDS,
    positionAbsMax: 1_000_000,
    ...overrides
  });
}

describe("受限执行：合法语义记录（任务 2.1 / 2.3）", () => {
  it("记录五类节点与规范字段", async () => {
    const outcome = await record(`
      canvas.node("text", { key: "t", title: "文本", prompt: "p" });
      canvas.node("image", { key: "i" });
      canvas.node("video", { key: "v" });
      canvas.node("audio", { key: "a" });
      canvas.node("model", { key: "m" });
    `);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.operations.map((op) => (op as { kind?: string }).kind)).toEqual(["text", "image", "video", "audio", "model"]);
    expect(outcome.operations[0]).toMatchObject({ op: "create_node", ref: "t", title: "文本", prompt: "p" });
  });

  it("记录 connect/move/setPrompt/remove 与有序计划", async () => {
    const outcome = await record(`
      const t = canvas.node("text", { key: "t", placement: { mode: "absolute", position: { x: 0, y: 0 } } });
      const i = canvas.node("image", { key: "i", placement: { mode: "after", anchor: t } });
      canvas.connect(t, i, { key: "e", label: "文本" });
      canvas.move(i, { x: 800, y: 100 });
      canvas.setPrompt(i, "画一只猫");
      canvas.remove(t);
    `);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.operations.map((op) => op.op)).toEqual([
      "create_node", "create_node", "connect", "move_node", "set_prompt", "delete"
    ]);
    expect(outcome.operations[2]).toMatchObject({ op: "connect", ref: "e", from: { ref: "t" }, to: { ref: "i" } });
    expect(outcome.operations[5]).toMatchObject({ op: "delete", targets: [{ ref: "t" }] });
  });

  it("placement/if 保留局部条件（不提前求值）", async () => {
    const outcome = await record(`
      const t = canvas.node("text", { key: "t", placement: { mode: "absolute", position: { x: 0, y: 0 } } });
      const i = canvas.node("image", { key: "i" });
      canvas.connect(t, i, { key: "e", if: { type: "prompt-equals", nodeId: "text-1", equals: "x" } });
      canvas.move(i, { x: 1, y: 1 }, { if: { type: "not-processing", nodeId: "img-1" } });
    `);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.operations[2] as { if?: unknown }).if).toEqual({ type: "prompt-equals", nodeId: "text-1", equals: "x" });
    expect((outcome.operations[3] as { if?: unknown }).if).toEqual({ type: "not-processing", nodeId: "img-1" });
  });

  it("existing 引用既有节点", async () => {
    const outcome = await record(`const n = canvas.existing("text-1"); canvas.move(n, { x: 5, y: 6 });`);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.operations[0]).toMatchObject({ op: "move_node", target: { nodeId: "text-1" } });
  });

  it("指南示例可生成预期语义计划", async () => {
    const outcome = await record(CANVAS_SCRIPT_GUIDE_EXAMPLE);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // text + 3 image + 3 edges。
    expect(outcome.operations.filter((op) => op.op === "create_node")).toHaveLength(4);
    expect(outcome.operations.filter((op) => op.op === "connect")).toHaveLength(3);
  });
});

describe("引用与 handle 身份（任务 2.3）", () => {
  it("伪造 handle 被拒绝", async () => {
    const outcome = await record(`canvas.move({ __kind: "node", __ref: "ghost" }, { x: 1, y: 1 });`);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid-ref");
  });

  it("边 handle 不能作为节点参数", async () => {
    const outcome = await record(`
      const t = canvas.node("text", { key: "t" });
      const i = canvas.node("image", { key: "i" });
      const e = canvas.connect(t, i, { key: "e" });
      canvas.move(e, { x: 1, y: 1 });
    `);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid-ref");
    expect(outcome.error.api).toBe("move");
  });

  it("重复 key 与自动/显式冲突被拒绝", async () => {
    const duplicate = await record(`
      canvas.node("text", { key: "k" });
      canvas.node("image", { key: "k" });
    `);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("duplicate-ref");

    const nodeEdgeShared = await record(`
      const t = canvas.node("text", { key: "k" });
      const i = canvas.node("image", { key: "i" });
      canvas.connect(t, i, { key: "k" });
    `);
    expect(nodeEdgeShared.ok).toBe(false);
    if (!nodeEdgeShared.ok) expect(nodeEdgeShared.error.code).toBe("duplicate-ref");
  });

  it("同一计划中删除后继续操作该节点被拒绝", async () => {
    const outcome = await record(`
      const t = canvas.node("text", { key: "t" });
      canvas.remove(t);
      canvas.setPrompt(t, "x");
    `);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("unknown-ref");
  });

  it("未知字段与非法 kind 在记录阶段被拒绝", async () => {
    const nodeData = await record(`canvas.node("text", { key: "t", nodeData: { evil: true } });`);
    expect(nodeData.ok).toBe(false);
    if (!nodeData.ok) expect(nodeData.error.code).toBe("malformed-request");

    const kind = await record(`canvas.node("group", {});`);
    expect(kind.ok).toBe(false);
    if (!kind.ok) expect(kind.error.code).toBe("unsupported-node-kind");

    const canonical = await record(`canvas.node("image", { key: "i", type: "custom-widget" });`);
    expect(canonical.ok).toBe(false);
    if (!canonical.ok) expect(canonical.error.code).toBe("malformed-request");
  });

  it("未知 placement/if 被拒绝", async () => {
    const placement = await record(`canvas.node("text", { placement: { mode: "above" } });`);
    expect(placement.ok).toBe(false);
    if (!placement.ok) expect(placement.error.code).toBe("unsupported-placement");

    const condition = await record(`canvas.move(canvas.existing("text-1"), { x: 1, y: 1 }, { if: { type: "nope", nodeId: "x" } });`);
    expect(condition.ok).toBe(false);
    if (!condition.ok) expect(condition.error.code).toBe("malformed-request");
  });
});

describe("宿主隔离与动态执行阻断（任务 2.2）", () => {
  /** 探针脚本：记录一个节点，若宿主入口可见则抛错——成功即证明不可见。 */
  function exposureProbe(expression: string): string {
    return `canvas.node("text", { key: "k" }); if (typeof (${expression}) !== "undefined") { throw new Error("exposed:${expression}"); }`;
  }

  const probes: Array<[string, string]> = [
    ["process", exposureProbe("process")],
    ["require", exposureProbe("require")],
    ["Date", exposureProbe("Date")],
    ["Promise", exposureProbe("Promise")],
    ["Function", exposureProbe("Function")],
    ["eval", exposureProbe("eval")],
    ["WebAssembly", exposureProbe("WebAssembly")],
    ["fetch", exposureProbe("fetch")],
    ["Math.random", exposureProbe("Math.random")],
    ["globalThis.constructor", `canvas.node("text", { key: "k" }); if (({}).constructor !== undefined && ({}).constructor !== Object) { throw new Error("exposed:constructor"); }`]
  ];

  for (const [name, source] of probes) {
    it(`宿主/异步入口不可见：${name}`, async () => {
      const outcome = await record(source);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.operations).toHaveLength(1);
    });
  }

  it("直接 eval 动态执行被阻止", async () => {
    // eval 已删除：任何调用都失败，脚本必须捕获并仍能正常记录计划。
    const outcome = await record(`
      canvas.node("text", { key: "k" });
      try { eval("1+1"); throw new Error("eval ran"); } catch (e) { if (String(e).indexOf("eval ran") >= 0) throw e; }
    `);
    expect(outcome.ok).toBe(true);
  });

  it("Function 构造器与 constructor 间接动态执行被阻止", async () => {
    const direct = await record(`
      canvas.node("text", { key: "k" });
      try { new Function("return 1")(); throw new Error("Function ran"); } catch (e) { if (String(e).indexOf("Function ran") >= 0) throw e; }
    `);
    expect(direct.ok).toBe(true);

    // constructor 链必须同样被断掉（prelude 先置空 Function.prototype.constructor）。
    const indirect = await record(`
      canvas.node("text", { key: "k" });
      try {
        const f = (function(){}).constructor("return typeof process");
        if (f() !== "undefined") throw new Error("constructor escaped");
      } catch (e) { if (String(e).indexOf("constructor escaped") >= 0) throw e; }
    `);
    expect(indirect.ok).toBe(true);
  });

  it("无宿主 IO 副作用：脚本只能记录计划", async () => {
    const outcome = await record(`
      canvas.node("text", { key: "t", title: "只有计划" });
    `);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.operations).toHaveLength(1);
  });
});

describe("执行边界与观察（任务 2.4 / 6.1）", () => {
  it("无限循环在时间预算内终止", async () => {
    const outcome = await record(`while (true) {}`, { deadlineMs: Date.now() + 300 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(["script-timeout", "script-runtime-error"]).toContain(outcome.error.code);
  }, 15_000);

  it("短脚本展开大量操作仍完整记录（任务 5.1）", async () => {
    // 原 256 操作 / 4096 API 调用额度已删除：短脚本通过循环生成的合法计划完整记录。
    const outcome = await record(`for (let i = 0; i < 1000; i++) { canvas.node("text", { key: "n" + i }); }`);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.operations).toHaveLength(1000);
  }, 30_000);

  it("内存耗尽返回内存预算错误", async () => {
    const outcome = await record(
      `const a = []; for (;;) { a.push(new Array(4096).fill("x")); }`,
      { heapLimitBytes: 4 * 1024 * 1024 }
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(["script-memory-limit", "script-timeout", "script-runtime-error"]).toContain(outcome.error.code);
  }, 15_000);

  it("大源码不再按字节上限拒绝（任务 5.1）", async () => {
    // 原 128 KiB 源码门禁已删除：超长但仍合法的脚本体正常进入记录阶段。
    const padding = "// " + "x".repeat(200_000) + "\n";
    const outcome = await record(`${padding}canvas.node("text", { key: "t" });`);
    expect(outcome.ok).toBe(true);
  });

  it("并发执行不再按数量拒绝（任务 6.1）", () => {
    const gate = new CanvasScriptConcurrencyGate();
    const slots = Array.from({ length: 40 }, (_value, index) => gate.acquire(`p-${index}`));
    // 任何数量都允许执行，只做观察性计数。
    expect(slots.every((slot) => slot.allowed)).toBe(true);
    expect(gate.activeCount).toBe(40);
    for (const slot of slots) slot.release();
    expect(gate.activeCount).toBe(0);
  });

  it("外部取消可从执行器外终止长时间脚本（任务 6.1）", async () => {
    const controller = new AbortController();
    const pending = record("for (;;) { /* spin */ }", { signal: controller.signal });
    // 让 realm 真正起来后取消（否则可能在 worker 启动前就结束）。
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(["cancelled", "script-timeout", "script-runtime-error"]).toContain(outcome.error.code);
  }, 20_000);
});

describe("双 realm 确定性与诊断（任务 2.5）", () => {
  it("确定性脚本在双独立 realm 下得到相同计划", async () => {
    const outcome = await record(`
      const base = canvas.node("text", { key: "b" });
      for (let i = 0; i < 3; i++) {
        const n = canvas.node("image", { key: "i" + i, placement: { mode: "after", anchor: base } });
        canvas.connect(base, n, { key: "e" + i });
      }
    `);
    expect(outcome.ok).toBe(true);
  });

  it("语法错误返回 compile 阶段定位且不含源码片段", async () => {
    const secret = "UNIQUE_SOURCE_MARKER_9f3a";
    const outcome = await record(`const ${secret} = ;`);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.stage).toBe("compile");
    expect(JSON.stringify(outcome.error)).not.toContain(secret);
  });

  it("API 错误返回 record 阶段与 api/field 定位，不回显源码", async () => {
    const secret = "UNIQUE_SOURCE_MARKER_9f3a";
    const outcome = await record(`canvas.node("text", { key: "k", title: "${secret}", badField: 1 });`);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.stage).toBe("record");
    expect(outcome.error.field).toBe("node options.badField");
    expect(JSON.stringify(outcome.error)).not.toContain("badField: 1");
  });
});

describe("prelude 事实源（任务 2.4）", () => {
  it("prelude 记录状态读取器返回严格 JSON", () => {
    const source = canvasScriptPrelude({
      nodeKinds: KINDS,
      textMaxChars: 8000,
      positionAbsMax: 1_000_000
    });
    expect(source).toContain("__woohaaCanvasScriptState");
    // 任务 5.1：prelude 不再包含操作数/API 调用额度常量。
    expect(source).not.toContain("MAX_OPS");
    expect(source).not.toContain("MAX_API_CALLS");
    expect(source).not.toContain("PROMPT_MAX");
    // 动态执行加固顺序：先断 constructor 再删 Function。
    expect(source.indexOf("Function.prototype")).toBeLessThan(source.indexOf('"Function"'));
  });
});

describe("提交哈希（任务 3.4）", () => {
  it("相同内容稳定、空白差异视为不同提交", async () => {
    const a = await canvasScriptSubmissionHash({ version: "woohaa-canvas-js-v1", source: "canvas.node('text',{});" });
    const b = await canvasScriptSubmissionHash({ version: "woohaa-canvas-js-v1", source: "canvas.node('text',{});" });
    const c = await canvasScriptSubmissionHash({ version: "woohaa-canvas-js-v1", source: "canvas.node('text',{ });" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("expectedRevision 参与哈希", async () => {
    const withRev = await canvasScriptSubmissionHash({ version: "woohaa-canvas-js-v1", source: "1", expectedRevision: 2 });
    const withoutRev = await canvasScriptSubmissionHash({ version: "woohaa-canvas-js-v1", source: "1" });
    expect(withRev).not.toBe(withoutRev);
  });
});
