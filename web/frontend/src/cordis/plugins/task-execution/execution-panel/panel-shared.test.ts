import { describe, expect, it } from "vitest";
import { missingRequiredParameters, parametersAfterModelSwitch, parametersOnOpen } from "./panel-shared.js";
import type { ExecutionPanelModelConfig } from "./types.js";

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
