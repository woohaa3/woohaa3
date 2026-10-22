import { describe, expect, it } from "vitest";
import { parametersAfterModelSwitch } from "./panel-shared.js";
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
