/**
 * 执行面板提交契约测试（change: add-image-text-node-execution，任务 2.2 / 2.3 / 2.4）。
 *
 * 断言三件事：
 * 1. `blockingReasons` 非空时主操作**真正**不可执行（不是只渲染出来）。
 * 2. 提交快照一定带 prompt / model / parameters，且 parameters 里的 model 与快照一致。
 * 3. idle / processing / succeeded / failed 四个受控状态都能驱动面板（不引入第二份状态）。
 */
import { describe, expect, it } from "vitest";
import { canRunExecution,
	executionRunSnapshot,
	isExecutionBlocked,
	isExecutionBusy, } from "./run-snapshot.js";

describe("canRunExecution", () => {
	it("有提示词且无阻止原因时可执行", () => {
		expect(canRunExecution({ prompt: "画一只猫" })).toBe(true);
	});

	it("空提示词不可执行", () => {
		expect(canRunExecution({ prompt: "   " })).toBe(false);
	});

	it("blockingReasons 非空时不可执行（即使提示词非空）", () => {
		expect(
			canRunExecution({ prompt: "画一只猫", blockingReasons: ["模型不支持参考图"] })
		).toBe(false);
	});

	it("空数组不算阻止", () => {
		expect(isExecutionBlocked([])).toBe(false);
		expect(canRunExecution({ prompt: "画一只猫", blockingReasons: [] })).toBe(true);
	});

	it("processing / pending 时不可执行", () => {
		expect(canRunExecution({ prompt: "画一只猫", status: "processing" })).toBe(false);
		expect(canRunExecution({ prompt: "画一只猫", status: "pending" })).toBe(false);
	});

	it("idle / successed / failed 都不算执行中，可再次执行", () => {
		expect(isExecutionBusy("idle")).toBe(false);
		expect(isExecutionBusy("successed")).toBe(false);
		expect(isExecutionBusy("failed")).toBe(false);
		expect(canRunExecution({ prompt: "画一只猫", status: "successed" })).toBe(true);
		expect(canRunExecution({ prompt: "画一只猫", status: "failed" })).toBe(true);
	});
});

describe("executionRunSnapshot", () => {
	it("携带 prompt / model / parameters 完整快照", () => {
		const snapshot = executionRunSnapshot({
			prompt: "雨夜霓虹街道",
			model: "gpt-image-2",
			parameters: { aspectRatio: "16:9", resolution: "2K" },
		});
		expect(snapshot).toEqual({
			prompt: "雨夜霓虹街道",
			model: "gpt-image-2",
			parameters: { aspectRatio: "16:9", resolution: "2K", model: "gpt-image-2" },
		});
	});

	it("parameters 里的 model 与快照 model 一致（选择器不会与参数脱节）", () => {
		const snapshot = executionRunSnapshot({
			prompt: "x",
			model: "gemini-3.1-flash-image",
			parameters: { model: "stale-model" },
		});
		expect(snapshot.parameters.model).toBe("gemini-3.1-flash-image");
		expect(snapshot.model).toBe("gemini-3.1-flash-image");
	});

	it("不修改传入的 parameters（避免宿主状态被面板偷偷改写）", () => {
		const parameters = { aspectRatio: "1:1" };
		executionRunSnapshot({ prompt: "x", model: "m", parameters });
		expect(parameters).toEqual({ aspectRatio: "1:1" });
	});

	it("原样保留 prompt（不做 trim，用户输入不被改写）", () => {
		const snapshot = executionRunSnapshot({ prompt: "  两侧有空格  ", model: "m", parameters: {} });
		expect(snapshot.prompt).toBe("  两侧有空格  ");
	});
});
