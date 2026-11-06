/**
 * 执行面板的纯逻辑：可否执行、提交快照（change: add-image-text-node-execution，任务 2.2 / 2.3）。
 *
 * 抽出来是为了让「blockingReasons 非空即禁用」和「快照一定包含 model」这两条契约
 * 能在没有 DOM 的环境里被直接断言（canvas-ui 的测试环境是 node，不引入 jsdom）。
 */
import type { ExecutionPanelRunSnapshot,
	ExecutionPanelStatus } from "./types.js";

/** 面板是否处于进行中状态。 */
export function isExecutionBusy(status: ExecutionPanelStatus | undefined): boolean {
	return status === "pending" || status === "processing" || status === "materializing";
}

/** 是否存在阻止执行的原因。 */
export function isExecutionBlocked(
	blockingReasons: ReadonlyArray<string> | undefined
): boolean {
	return (blockingReasons?.length ?? 0) > 0;
}

/**
 * 主操作是否可用。
 *
 * 三个条件缺一不可：有提示词、不在执行中、没有阻止原因。
 * `blockingReasons` 必须**真正**参与判断 —— 只把它渲染出来会让用户点一个注定失败的按钮。
 */
export function canRunExecution(input: {
	prompt: string;
	status?: ExecutionPanelStatus;
	blockingReasons?: ReadonlyArray<string>;
}): boolean {
	return (
		input.prompt.trim().length > 0 &&
		!isExecutionBusy(input.status) &&
		!isExecutionBlocked(input.blockingReasons)
	);
}

/**
 * 构造提交快照。
 *
 * `parameters` 一定带上当前 `model`，因为模型选择本身就是参数的一部分；
 * 否则宿主收到的 parameters 与面板显示可能不一致（选择器显示 A，参数里却是 B）。
 */
export function executionRunSnapshot(input: {
	prompt: string;
	model: string;
	parameters: Record<string, unknown>;
}): ExecutionPanelRunSnapshot {
	return {
		prompt: input.prompt,
		model: input.model,
		parameters: { ...input.parameters, model: input.model }
	};
}
