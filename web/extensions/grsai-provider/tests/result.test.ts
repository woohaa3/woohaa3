import { describe, expect, it } from "vitest";
import { collectUrls, grsaiErrorMessage, grsaiTaskId, interpretGrsaiResult } from "../src/result.js";

describe("grsai 响应解读", () => {
  it("提交响应取任务 id，失败响应取消息", () => {
    expect(grsaiTaskId({ id: "6-f671fc51", status: "running" })).toBe("6-f671fc51");
    expect(grsaiTaskId({ status: "running" })).toBe("");
    expect(grsaiErrorMessage({ id: "", status: "failed", error: "apikey is empty" })).toBe("apikey is empty");
    expect(grsaiErrorMessage({ error: "result not exist, valid for 2 hours" })).toBe("result not exist, valid for 2 hours");
    expect(grsaiErrorMessage({ status: "succeeded" })).toBeUndefined();
  });

  it("按状态给出 pending / completed / failed", () => {
    expect(interpretGrsaiResult({ id: "t", status: "running", progress: 40 })).toEqual({ state: "pending", phase: "running", progress: 40 });
    expect(interpretGrsaiResult({ id: "t", status: "queued" })).toEqual({ state: "pending", phase: "queued" });
    expect(interpretGrsaiResult({ id: "t", status: "succeeded", results: [{ url: "https://files.test/a.png" }] }))
      .toEqual({ state: "completed", urls: ["https://files.test/a.png"] });
    expect(interpretGrsaiResult({ id: "t", status: "failed", error: "generate failed" })).toEqual({ state: "failed", error: "generate failed" });
    expect(interpretGrsaiResult({ id: "t", status: "violation", failure_reason: "output_moderation" }))
      .toEqual({ state: "failed", error: "grsai 任务结束于 violation" });
  });

  it("进度按 0-1 或 0-100 归一，并兜住「有输出但没状态」的返回", () => {
    expect(interpretGrsaiResult({ status: "running", progress: 0.5 })).toMatchObject({ progress: 50 });
    expect(interpretGrsaiResult({ results: [{ url: "https://files.test/a.png" }] }))
      .toEqual({ state: "completed", urls: ["https://files.test/a.png"] });
    expect(interpretGrsaiResult({ status: "succeeded", results: [] }))
      .toEqual({ state: "failed", error: "grsai 没有返回输出地址" });
    expect(collectUrls({ results: [{ url: "https://a.test/1.png" }, { url: "https://a.test/1.png" }] })).toEqual(["https://a.test/1.png"]);
  });
});
