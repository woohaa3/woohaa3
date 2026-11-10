import { describe, expect, it } from "vitest";
import { missingRequiredParameters, parametersAfterModelSwitch, parametersOnOpen, parameterViolationReasons } from "./panel-shared.js";
import type { ExecutionPanelModelConfig, ExecutionPanelParameterField } from "./types.js";

const CONFIG: ExecutionPanelModelConfig = {
	modelOptions: [
		{ value: "gpt-image-2", label: "GPT Image 2" },
		{ value: "gemini-3-pro-image", label: "Gemini 3 Pro Image" },
		{ value: "seedream-5-pro", label: "Seedream 5 Pro" },
	],
	defaultModel: "gpt-image-2",
	parameterSchemaByModel: {
		"gpt-image-2": [
			{
				key: "resolution", label: "图片分辨率", type: "select",
				options: ["1K", "2K", "4K"].map((value) => ({ value, label: value })),
				defaultValue: "1K",
			},
			{
				key: "aspectRatio", label: "图片比例", type: "select",
				options: ["auto", "1:1", "16:9"].map((value) => ({ value, label: value })),
				defaultValue: "1:1",
			},
			{
				key: "quality", label: "质量", type: "select",
				options: ["auto", "low", "medium", "high"].map((value) => ({ value, label: value })),
				defaultValue: "high",
			},
			{ key: "n", label: "数量", type: "number", minimum: 1, maximum: 10, defaultValue: 1 },
		],
		"gemini-3-pro-image": [
			{
				key: "resolution", label: "图片分辨率", type: "select",
				options: ["1K", "2K", "4K"].map((value) => ({ value, label: value })),
				defaultValue: "1K",
			},
			{
				key: "aspectRatio", label: "图片比例", type: "select",
				options: ["auto", "1:1", "16:9"].map((value) => ({ value, label: value })),
				defaultValue: "auto",
			},
		],
		"seedream-5-pro": [
			{
				key: "size", label: "尺寸", type: "select",
				options: ["1024x1024", "1536x1024"].map((value) => ({ value, label: value })),
				defaultValue: "1024x1024",
			},
			{
				key: "quality", label: "质量", type: "select",
				options: ["auto", "low", "medium", "high", "standard", "hd"].map((value) => ({ value, label: value })),
				defaultValue: "auto",
			},
		],
	},
	defaultsByModel: {
		"gpt-image-2": { resolution: "1K", aspectRatio: "1:1", quality: "high", n: 1 },
		"gemini-3-pro-image": { resolution: "1K", aspectRatio: "auto" },
		"seedream-5-pro": { size: "1024x1024", quality: "auto" },
	},
};

describe("parametersAfterModelSwitch", () => {
	it("drops parameters that the new model does not declare", () => {
		const next = parametersAfterModelSwitch(
			CONFIG,
			{ model: "gpt-image-2", resolution: "2K", aspectRatio: "16:9", quality: "hd", n: 4 },
			"gemini-3-pro-image",
		);

		expect(next).toEqual({ model: "gemini-3-pro-image", resolution: "2K", aspectRatio: "16:9" });
	});

	it("fills new-model defaults for fields the old model did not have", () => {
		const next = parametersAfterModelSwitch(
			CONFIG,
			{ model: "gemini-3-pro-image", resolution: "2K", aspectRatio: "auto" },
			"gpt-image-2",
		);

		expect(next).toEqual({
			model: "gpt-image-2", resolution: "2K", aspectRatio: "auto", quality: "high", n: 1,
		});
	});

	it("drops enum values that are invalid for the new model", () => {
		const next = parametersAfterModelSwitch(
			CONFIG,
			{ model: "seedream-5-pro", size: "1536x1024", quality: "hd" },
			"gpt-image-2",
		);

		expect(next).toEqual({
			model: "gpt-image-2", resolution: "1K", aspectRatio: "1:1", quality: "high", n: 1,
		});
	});

	it("keeps valid values that the new model shares", () => {
		const next = parametersAfterModelSwitch(
			CONFIG,
			{ model: "gpt-image-2", resolution: "4K", aspectRatio: "16:9", quality: "low", n: 2 },
			"gemini-3-pro-image",
		);

		expect(next).toEqual({ model: "gemini-3-pro-image", resolution: "4K", aspectRatio: "16:9" });
	});

	/**
	 * 现场事故（task-e5f853e773032d20344da5ab64c68509）：MiniMax 语音任务的
	 * `voice=male-qn-qingse` 被带进 `lyria3`，而 lyria3 只接受 OpenAI 音色名，请求直接 500。
	 *
	 * 音乐模型的目录 schema 里没有 voice，所以切模型时它必须被丢弃——这是结构性修复，
	 * 不依赖参数校验兜底。
	 */
	it("语音切到音乐时丢弃音色：音乐模型不声明 voice", () => {
		const audioConfig: ExecutionPanelModelConfig = {
			modelOptions: [
				{ value: "minimax-speech-2.8-hd", label: "MiniMax Speech" },
				{ value: "lyria3", label: "Lyria 3" },
			],
			defaultModel: "minimax-speech-2.8-hd",
			parameterSchemaByModel: {
				"minimax-speech-2.8-hd": [
					{ key: "voice", label: "音色", type: "select", options: [{ value: "male-qn-qingse", label: "青涩" }] },
					{ key: "speed", label: "语速", type: "number", minimum: 0.5, maximum: 2 },
				],
				lyria3: [{ key: "lyrics", label: "歌词", type: "textarea", defaultValue: "" }],
			},
			defaultsByModel: {
				"minimax-speech-2.8-hd": { voice: "male-qn-qingse", speed: 1 },
				lyria3: { lyrics: "" },
			},
		};
		const next = parametersAfterModelSwitch(
			audioConfig,
			{ model: "minimax-speech-2.8-hd", voice: "male-qn-qingse", speed: 1 },
			"lyria3",
		);

		expect(next.voice).toBeUndefined();
		expect(next.speed).toBeUndefined();
		expect(next).toEqual({ model: "lyria3", lyrics: "" });
	});

	it("反向切换（音乐到语音）带回语音默认音色", () => {
		const audioConfig: ExecutionPanelModelConfig = {
			modelOptions: [
				{ value: "minimax-speech-2.8-hd", label: "MiniMax Speech" },
				{ value: "lyria3", label: "Lyria 3" },
			],
			defaultModel: "minimax-speech-2.8-hd",
			parameterSchemaByModel: {
				"minimax-speech-2.8-hd": [
					{ key: "voice", label: "音色", type: "select", options: [{ value: "male-qn-qingse", label: "青涩" }] },
				],
				lyria3: [{ key: "lyrics", label: "歌词", type: "textarea", defaultValue: "" }],
			},
			defaultsByModel: {
				"minimax-speech-2.8-hd": { voice: "male-qn-qingse" },
				lyria3: { lyrics: "" },
			},
		};
		const next = parametersAfterModelSwitch(
			audioConfig,
			{ model: "lyria3", lyrics: "两只老虎" },
			"minimax-speech-2.8-hd",
		);

		expect(next).toEqual({ model: "minimax-speech-2.8-hd", voice: "male-qn-qingse" });
	});
});

/**
 * A9 回归：面板打开时也要并入 schema 默认值，并在提交前按 required 校验。
 *
 * 之前 `parametersAfterModelSwitch` 只在**切换模型**时跑；首次打开面板 `parameters` 是
 * 空对象，720p/5 这些默认值只用于渲染控件，没有进提交草稿。Provider 收到
 * `field 'resolution' is required, can not be empty`（2026-10-24 preflight #1）。
 */
describe("parametersOnOpen", () => {
	it("首次打开（草稿为空）就带出该模型的全部默认值", () => {
		expect(parametersOnOpen(CONFIG, {}, "gemini-3-pro-image")).toEqual({
			model: "gemini-3-pro-image", resolution: "1K", aspectRatio: "auto",
		});
	});

	it("已有草稿值优先，只补缺", () => {
		expect(parametersOnOpen(CONFIG, { aspectRatio: "16:9" }, "gpt-image-2")).toEqual({
			model: "gpt-image-2", resolution: "1K", aspectRatio: "16:9", quality: "high", n: 1,
		});
	});

	it("null 与空串不压掉默认值（恢复损坏草稿时也要能提交）", () => {
		expect(parametersOnOpen(CONFIG, { resolution: null, quality: "" }, "gpt-image-2")).toMatchObject({
			resolution: "1K", quality: "high",
		});
	});
});

describe("missingRequiredParameters", () => {
	const REQUIRED: ExecutionPanelModelConfig = {
		...CONFIG,
		parameterSchemaByModel: {
			...CONFIG.parameterSchemaByModel,
			"seedance-video": [
				{
					key: "resolution", label: "分辨率", type: "select", required: true,
					options: ["480p", "720p", "1080p"].map((value) => ({ value, label: value })),
					defaultValue: "720p",
				},
				{ key: "duration", label: "时长", type: "number", required: true, minimum: 1, maximum: 30, defaultValue: 5 },
				{
					key: "ratio", label: "比例", type: "select",
					options: ["auto", "16:9"].map((value) => ({ value, label: value })),
				},
			],
		},
		defaultsByModel: { ...CONFIG.defaultsByModel, "seedance-video": { resolution: "720p", duration: 5 } },
	};

	it("默认值补齐后没有缺项", () => {
		const params = parametersOnOpen(REQUIRED, {}, "seedance-video");
		expect(missingRequiredParameters(REQUIRED, params, "seedance-video")).toEqual([]);
	});

	it("真的缺了必填项时报出来，且不把非必填项算进去", () => {
		const missing = missingRequiredParameters(REQUIRED, { ratio: "auto" }, "seedance-video");
		expect(missing.map((field) => field.key)).toEqual(["resolution", "duration"]);
	});

	it("隐藏字段不参与必填判定", () => {
		const config: ExecutionPanelModelConfig = {
			...REQUIRED,
			parameterSchemaByModel: {
				...REQUIRED.parameterSchemaByModel,
				hidden: [
					{
						key: "resolution", label: "分辨率", type: "select", required: true,
						options: [{ value: "720p", label: "720p" }],
						hiddenWhen: [{ field: "mode", equals: "fixed" }],
					},
				],
			},
		};
		expect(missingRequiredParameters(config, { mode: "fixed" }, "hidden")).toEqual([]);
	});
});

/**
 * 提交前的参数值约束（枚举 / 数值范围）：越界不要让请求发出去再等 Provider 回泛化错误，
 * 面板就地给出「哪个字段、允许什么」的中文句子并在提交前禁用主操作。
 */
describe("parameterViolationReasons", () => {
	const FIELDS: ReadonlyArray<ExecutionPanelParameterField> =
		CONFIG.parameterSchemaByModel?.["gpt-image-2"] ?? [];

	it("合法值不报原因", () => {
		expect(parameterViolationReasons(FIELDS, { resolution: "2K", aspectRatio: "16:9", n: 4 })).toEqual([]);
	});

	it("枚举外的值报出字段与允许选项", () => {
		expect(parameterViolationReasons(FIELDS, { quality: "hd" })).toEqual([
			"质量只支持 auto、low、medium、high，当前为「hd」",
		]);
	});

	it("数值低于下限 / 高于上限分别报出可读范围", () => {
		expect(parameterViolationReasons(FIELDS, { n: 0 })).toEqual(["数量不能小于 1，当前为 0"]);
		expect(parameterViolationReasons(FIELDS, { n: 99 })).toEqual(["数量不能大于 10，当前为 99"]);
	});

	it("空值不参与判定，隐藏字段越界也不报", () => {
		expect(parameterViolationReasons(FIELDS, { quality: "", n: null })).toEqual([]);
		const hidden: ExecutionPanelParameterField[] = [
			{
				key: "size", label: "尺寸", type: "select",
				options: [{ value: "1024x1024", label: "1024x1024" }],
				hiddenWhen: [{ field: "mode", equals: "fixed" }],
			},
		];
		expect(parameterViolationReasons(hidden, { mode: "fixed", size: "999x999" })).toEqual([]);
	});
});
