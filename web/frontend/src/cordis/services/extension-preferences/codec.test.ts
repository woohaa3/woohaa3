/**
 * 插件偏好 codec 测试
 * （change: add-frontend-plugin-manager，任务 2.1）。
 */
import { describe, expect, it } from "vitest";
import {
  FRONTEND_PLUGIN_PREFERENCES_KEY,
  defaultPreferences,
  normalizePreferences,
  parsePreferences,
  serializePreferences
} from "./codec.js";

const IDS = ["task-activity", "prompt-snippets", "node-history"] as const;

describe("插件偏好 codec（任务 2.1）", () => {
  it("版本化键稳定", () => {
    expect(FRONTEND_PLUGIN_PREFERENCES_KEY).toBe("woohaa:frontend-extensions:v1");
  });

  it("缺失配置返回全启用默认值且无诊断", () => {
    const result = parsePreferences(null, IDS);
    expect(result.preferences).toEqual({ "task-activity": true, "prompt-snippets": true, "node-history": true });
    expect(result.diagnostic).toBeNull();
  });

  it("有效映射只保留已知 ID 并补齐全启用", () => {
    const result = parsePreferences(JSON.stringify({ "node-history": false }), IDS);
    expect(result.preferences).toEqual({ "task-activity": true, "prompt-snippets": true, "node-history": false });
    expect(result.diagnostic).toBeNull();
  });

  it("malformed JSON 整体降级到全启用并报告类别", () => {
    const result = parsePreferences("{not json", IDS);
    expect(result.preferences).toEqual(defaultPreferences(IDS));
    expect(result.diagnostic?.code).toBe("malformed-json");
    expect(JSON.stringify(result.diagnostic)).not.toContain("not json");
  });

  it("非 object（数组/标量）整体降级", () => {
    expect(parsePreferences("[true]", IDS).diagnostic?.code).toBe("not-object");
    expect(parsePreferences("true", IDS).diagnostic?.code).toBe("not-object");
    expect(parsePreferences("\"x\"", IDS).diagnostic?.code).toBe("not-object");
  });

  it("已知 ID 的非 boolean 值整体降级且不回显原始内容", () => {
    const result = parsePreferences(JSON.stringify({ "task-activity": "yes" }), IDS);
    expect(result.preferences).toEqual(defaultPreferences(IDS));
    expect(result.diagnostic?.code).toBe("non-boolean");
    expect(JSON.stringify(result.diagnostic)).not.toContain("yes");
  });

  it("未知/required ID 被忽略并报告 unknown-ids，合法已知值仍生效", () => {
    const result = parsePreferences(
      JSON.stringify({ "node-history": false, "model-editor": false, mystery: true }),
      IDS
    );
    expect(result.preferences["node-history"]).toBe(false);
    expect(result.preferences["model-editor"]).toBeUndefined();
    expect(result.diagnostic?.code).toBe("unknown-ids");
    // 摘要不含具体 ID 内容之外的信息；这里只断言不回显 required 值语义。
    expect(result.diagnostic?.detail).toContain("2");
  });

  it("序列化产生规范化完整 map", () => {
    const raw = serializePreferences(IDS, { "node-history": false });
    expect(JSON.parse(raw)).toEqual({ "task-activity": true, "prompt-snippets": true, "node-history": false });
  });

  it("normalizePreferences 只保留 allowlist ID", () => {
    const normalized = normalizePreferences(IDS, { "node-history": false, "model-editor": false } as never);
    expect(Object.keys(normalized).sort()).toEqual([...IDS].sort());
  });
});
