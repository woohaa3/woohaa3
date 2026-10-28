import { useSyncExternalStore } from "react";
import { darkAppTheme, defaultAppTheme, sentinelAppTheme, validateAppThemePreset, APP_THEME_SCHEMA_VERSION } from "@woohaa3/contracts";
import { AppThemeService } from "../../../frontend/src/cordis/ui/index";
import { ThemeProvider, useThemeService } from "@woohaa3/ui/theme";
import { SegmentedControl } from "@woohaa3/ui/primitives";
import { MoonIcon, SparklesIcon, SunIcon } from "@woohaa3/ui/icons";

/**
 * Showcase 使用的唯一 Theme Service（change: unify-application-theme-tokens，任务 2.4）。
 *
 * 与生产应用默认同色调；注册产品内置 `default`/`dark` 与测试用 `sentinel` 三个 preset，
 * 支持直接预览暗色及一键注入哨兵主题，证明「替换 preset 即改变全部色调」。
 */
const defaultPreset = {
	id: "default",
	version: APP_THEME_SCHEMA_VERSION,
	tokens: defaultAppTheme().tokens,
};
const sentinelPreset = {
	id: "sentinel",
	version: APP_THEME_SCHEMA_VERSION,
	tokens: sentinelAppTheme().tokens,
};
const darkPreset = {
	id: "dark",
	version: APP_THEME_SCHEMA_VERSION,
	tokens: darkAppTheme().tokens,
};

// 用校验过的快照（保证 showcase 主题与生产同构）。
const validatedDefault = validateAppThemePreset(defaultPreset);
const validatedDark = validateAppThemePreset(darkPreset);
const validatedSentinel = validateAppThemePreset(sentinelPreset);

export const showcaseThemeService = new AppThemeService({
	initial: validatedDefault.ok ? validatedDefault.theme : defaultAppTheme(),
	storage: null,
	restore: false,
	presets: {
		default: validatedDefault.ok ? validatedDefault.theme : defaultAppTheme(),
		dark: validatedDark.ok ? validatedDark.theme : darkAppTheme(),
		sentinel: validatedSentinel.ok ? validatedSentinel.theme : defaultAppTheme(),
	},
});

export { ThemeProvider };

type PresetId = "default" | "dark" | "sentinel";

const THEME_OPTIONS: ReadonlyArray<{
	id: PresetId;
	label: string;
	hint: string;
	Icon: typeof SunIcon;
}> = [
	{ id: "default", label: "浅色", hint: "产品内置浅色 preset", Icon: SunIcon },
	{ id: "dark", label: "暗色", hint: "产品内置暗色 preset", Icon: MoonIcon },
	{ id: "sentinel", label: "哨兵", hint: "哨兵主题 preset（替换全部色调）", Icon: SparklesIcon },
];

/**
 * 主题切换（change: 2026-09-29-refresh-showcase-shell，design D2/D5；
 *  change: adopt-radix-lucide-canvas-ui 任务 8.1：改为消费生产 SegmentedControl 与 icon facade）。
 *
 * 用生产 SegmentedControl（single）表达「二选一」；`value` 由 Theme Service 受控，
 * single 模式显式忽略空值，因此再次激活当前项不会取消到无主题。切换仍走同一个 `select()`
 * 契约，不新增平行 theme state。
 */
export function ThemeToggle() {
	const service = useThemeService<AppThemeService>();
	const theme = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
	return (
		<SegmentedControl
			className="showcase__theme-toggle"
			label="主题 preset"
			value={theme.id}
			dataAttributes={{ "data-theme-id": theme.id }}
			onValueChange={(value) => {
				if (value === "default" || value === "dark" || value === "sentinel") service.select(value);
			}}
			optionClassName="showcase__theme-option"
			options={THEME_OPTIONS.map(({ id, label, hint, Icon }) => ({
				value: id,
				ariaLabel: `${label}主题`,
				title: hint,
				label,
				icon: <Icon className="showcase__theme-icon" />
			}))}
		/>
	);
}
