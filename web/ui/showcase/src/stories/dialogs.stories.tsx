import type { Story, StoryDefault } from "@ladle/react";
import { AlertDialog, Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@woohaa3/ui/dialogs";
import { MediaDialog } from "@woohaa3/ui/media";
import { DialogViewport } from "../dialog-viewport.js";
import { DialogHostStage } from "../dialog-fixtures.js";
import {
	createLibraryRenderer,
	SNIPPET_LIBRARY_DIALOG_ID,
	snippetLibraryDefinition,
	useShowcaseCatalog,
} from "../snippet-fixtures.js";

export default {
	title: "画布组件/弹窗/基础",
} satisfies StoryDefault;

/** 通用弹窗骨架：Header（含关闭）/ Body / Footer，三种尺寸与四种变体。 */
export const StandardMd: Story = () => (
	<DialogViewport>
		<Dialog.Content variant="standard" size="md" labelledBy="dlg-standard-title" describedBy="dlg-standard-desc">
			<DialogHeader onClose={() => undefined}>
				<DialogTitle id="dlg-standard-title">通用弹窗</DialogTitle>
			</DialogHeader>
			<DialogBody>
				<DialogDescription id="dlg-standard-desc">
					standard / md。Header 固定、Body 独立滚动、Footer 固定。
				</DialogDescription>
			</DialogBody>
			<DialogFooter>
				<button type="button" className="dlg__button">
					取消
				</button>
				<button type="button" className="dlg__button dlg__button--primary">
					确定
				</button>
			</DialogFooter>
		</Dialog.Content>
	</DialogViewport>
);
StandardMd.storyName = "标准 md";

export const StandardLg: Story = () => (
	<DialogViewport>
		<Dialog.Content variant="standard" size="lg" ariaLabel="大尺寸弹窗">
			<DialogHeader onClose={() => undefined}>
				<DialogTitle>大尺寸弹窗</DialogTitle>
			</DialogHeader>
			<DialogBody>
				<p>standard / lg。用于列表、编辑器等需要更多空间的场景。</p>
			</DialogBody>
			<DialogFooter>
				<button type="button" className="dlg__button dlg__button--primary">
					完成
				</button>
			</DialogFooter>
		</Dialog.Content>
	</DialogViewport>
);
StandardLg.storyName = "标准 lg";

/**
 * 窄屏（390×844）长内容弹窗：验证 Header/Footer 可达、Body 独立滚动，
 * 且弹窗按生产规则收缩（任务 1.1 / 1.2）。
 */
export const NarrowLongContent: Story = () => (
	<DialogViewport narrow testId="dialog-viewport-narrow">
		<Dialog.Content variant="standard" size="lg" ariaLabel="长内容弹窗">
			<DialogHeader onClose={() => undefined}>
				<DialogTitle>窄屏长内容</DialogTitle>
			</DialogHeader>
			<DialogBody>
				{Array.from({ length: 24 }, (_, index) => (
					<p key={index}>第 {index + 1} 段：内容超过一屏，必须能在 Body 内滚动到达。</p>
				))}
			</DialogBody>
			<DialogFooter>
				<button type="button" className="dlg__button">
					取消
				</button>
				<button type="button" className="dlg__button dlg__button--primary">
					确定
				</button>
			</DialogFooter>
		</Dialog.Content>
	</DialogViewport>
);
NarrowLongContent.storyName = "窄屏 长内容";

export const Alert: Story = () => (
	<DialogViewport width={420}>
		<AlertDialog
			instanceId="story-alert"
			title="删除节点"
			description="删除后不可撤销，关联的连线也会一并移除。"
			confirmLabel="删除"
			cancelLabel="取消"
			danger
			onCancel={() => undefined}
			onConfirm={async () => ({ ok: true })}
		/>
	</DialogViewport>
);
Alert.storyName = "确认 危险操作";

export const AlertBusy: Story = () => (
	<DialogViewport width={420}>
		<AlertDialog
			instanceId="story-alert-busy"
			title="正在保存"
			description="确认后调用方保持 busy，直到按实例关闭。"
			confirmLabel="保存"
			onCancel={() => undefined}
			onConfirm={async () => new Promise(() => undefined)}
		/>
	</DialogViewport>
);
AlertBusy.storyName = "确认 进行中";

/** 焦点恢复：用生产 DialogHost + 生产片段库弹窗验证打开/关闭后的焦点归属（任务 1.2）。 */
export const FocusRestore: Story = () => {
	const catalog = useShowcaseCatalog();
	const renderer = createLibraryRenderer(catalog, {
		openEditor: () => undefined,
		requestDelete: () => undefined,
		requestDeleteTag: () => undefined,
	});
	return (
		<DialogHostStage
			registrations={[
				{ dialogId: SNIPPET_LIBRARY_DIALOG_ID, definition: snippetLibraryDefinition, renderer },
			]}
			dialogId={SNIPPET_LIBRARY_DIALOG_ID}
			payload={{}}
			triggerLabel="打开片段库"
			caption="焦点恢复 · 生产 DialogHost"
			hint="点击触发按钮打开弹窗，关闭后焦点回到触发按钮。"
		/>
	);
};
FocusRestore.storyName = "焦点恢复";

export const MediaImage: Story = () => (
	<DialogViewport>
		<MediaDialog
			instanceId="story-media"
			title="生成结果 · 电影感森林"
			url="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%232b6a5a'/%3E%3Cstop offset='1' stop-color='%230f2a33'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='640' height='360' fill='url(%23g)'/%3E%3Ccircle cx='470' cy='110' r='54' fill='%23ffd9a0' opacity='0.85'/%3E%3C/svg%3E"
			kind="image"
			onClose={() => undefined}
		/>
	</DialogViewport>
);
MediaImage.storyName = "媒体预览 图片";

export const MediaUnavailable: Story = () => (
	<DialogViewport>
		<MediaDialog
			instanceId="story-media-missing"
			title="该媒体已失效"
			url={null}
			unavailableReason="该图片资产已失效或不可预览"
			onClose={() => undefined}
		/>
	</DialogViewport>
);
MediaUnavailable.storyName = "媒体预览 不可用";
