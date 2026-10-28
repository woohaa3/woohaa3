/**
 * 共享 Dialog primitives（change: add-frontend-dialog-system，任务 2.1 / 2.2 / design D1/D7；
 *  change: adopt-radix-lucide-canvas-ui 任务 6.4：底层改用 Radix DialogSurface adapter）。
 *
 * 只负责单个弹窗的结构、无障碍语义与关闭策略；stack 顺序、焦点和输入 scope 由 Host
 * 统一决定。业务弹窗 MUST 复用这些组合组件，不得各自实现 document-level modal/Escape。
 *
 * variant：standard / alert / media / sheet；size：sm / md / lg / fullscreen。
 */
import type { ReactNode } from "react";
import type { DialogSize, DialogVariant } from "./types.js";
import { CloseIcon } from "../icons/icons.js";
import { IconButton } from "../primitives/Button.js";
import { DialogSurface, useDialogSurfaceContext } from "../primitives/DialogSurface.js";
import { UiPortalScope } from "../primitives/UiProvider.js";

export type DialogContentProps = {
  variant?: DialogVariant;
  size?: DialogSize;
  /** 业务表面追加布局类，不改变弹窗状态。 */
  className?: string;
  /** 可访问名称来源：`aria-labelledby` 指向的 Title 元素 id。 */
  labelledBy?: string;
  /** 可访问描述来源：`aria-describedby` 指向的 Description 元素 id。 */
  describedBy?: string;
  /** 无 Title 时的兜底可访问名（二者至少一个）。 */
  ariaLabel?: string;
  /** busy：`aria-busy` 且禁止隐式关闭（由 Host/调用方配合）。 */
  busy?: boolean;
  /** 点击遮罩的回调（是否可关闭由 Host 的 close policy 决定）。 */
  onOverlayClick?: () => void;
  /** 测试/定位用实例标识。 */
  instanceId?: string;
  children: ReactNode;
};

/**
 * 单个弹窗内容容器。
 *
 * 强制可访问名：必须提供 `ariaLabel` 或 `labelledBy`，否则抛错（design：无名称弹窗不可发布）。
 * 命中 Dialog Host context 时使用 Radix DialogSurface（modal/focus/dismiss）；脱离 Host
 * （Showcase/单测静态渲染）时退化为既有 markup。
 */
export function DialogContent(props: DialogContentProps) {
  if (!props.ariaLabel && !props.labelledBy) {
    throw new Error("DialogContent 需要 ariaLabel 或 labelledBy（可访问名称）");
  }
  const host = useDialogSurfaceContext();
  const variant = props.variant ?? "standard";
  const size = props.size ?? "md";
  const classes = [
    "dlg",
    props.className,
    `dlg--${variant}`,
    `dlg--${size}`,
    props.busy ? "dlg--busy" : ""
  ]
    .filter(Boolean)
    .join(" ");
  void host;
  return (
    <DialogSurface
      className={classes}
      busy={props.busy ?? false}
      {...(props.ariaLabel ? { ariaLabel: props.ariaLabel } : {})}
      {...(props.labelledBy ? { labelledBy: props.labelledBy } : {})}
      {...(props.describedBy ? { describedBy: props.describedBy } : {})}
      {...(props.instanceId ? { instanceId: props.instanceId } : {})}
      {...(props.onOverlayClick ? { onOverlayClick: props.onOverlayClick } : {})}
    >
      <UiPortalScope>{props.children}</UiPortalScope>
    </DialogSurface>
  );
}

/** Header：标题行 + 可选关闭按钮（图标语言，不再是 `✕` 字符）。 */
export function DialogHeader(props: { children: ReactNode; onClose?: () => void; closeLabel?: string }) {
  return (
    <header className="dlg__header">
      <div className="dlg__header-text">{props.children}</div>
      {props.onClose ? (
        <DialogIconButton
          className="dlg__close"
          label={props.closeLabel ?? "关闭"}
          tooltip="关闭"
          icon={<CloseIcon className="dlg__icon dlg__close-icon" />}
          onClick={props.onClose}
        />
      ) : null}
    </header>
  );
}

/** 可访问标题。 */
export function DialogTitle(props: { id?: string; children: ReactNode }) {
  return (
    <h2 className="dlg__title" id={props.id}>
      {props.children}
    </h2>
  );
}

/** 可访问描述（补充说明）。 */
export function DialogDescription(props: { id?: string; children: ReactNode }) {
  return (
    <p className="dlg__description" id={props.id}>
      {props.children}
    </p>
  );
}

/** 独立滚动的正文区。 */
export function DialogBody(props: { children: ReactNode; className?: string }) {
  return <div className={["dlg__body", props.className].filter(Boolean).join(" ")}>{props.children}</div>;
}

/** 工具条（媒体缩放/播放等紧凑控件）。 */
export function DialogToolbar(props: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div
      className={["dlg__toolbar", props.className].filter(Boolean).join(" ")}
      role="toolbar"
      aria-label={props.label}
    >
      {props.children}
    </div>
  );
}

/** 分区标题/内容。 */
export function DialogSection(props: { children: ReactNode; className?: string }) {
  return <section className={["dlg__section", props.className].filter(Boolean).join(" ")}>{props.children}</section>;
}

/**
 * 共享媒体工作区 composition（change: 2026-09-29-align-node-media-dialogs，design D2）。
 *
 * 桌面为稳定的主媒体区 + 可选辅助区；窄屏降为单列。只负责结构与框高，不提升业务 state、
 * 不读写媒体 intrinsic size，因此 Content 外框不随素材比例跳动。
 */
export function DialogMediaWorkspace(props: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div
      className={[
        "dlg__media-workspace",
        props.aside ? "dlg__media-workspace--split" : "",
        props.className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="dlg__media-main">{props.children}</div>
      {props.aside ? <div className="dlg__media-aside">{props.aside}</div> : null}
    </div>
  );
}

/**
 * 媒体舞台：中性高对比 surface 上按 contain 呈现图片/视频，自身裁切平移/缩放。
 * `label` 提供可访问组名；媒体 token 只允许出现在此舞台与其叠层内（design D1）。
 */
export function DialogStage(props: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div
      className={["dlg__stage", props.className].filter(Boolean).join(" ")}
      role="group"
      aria-label={props.label}
    >
      {props.children}
    </div>
  );
}

export type DialogIconButtonProps = {
  /** 可访问名称（必填：icon-only 按钮必须有名称）。 */
  label: string;
  /** 非显而易见操作的补充提示。 */
  tooltip?: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** 切换类操作的按下态（如静音、选帧）。 */
  pressed?: boolean;
  className?: string;
  /** 测试/定位用标识。 */
  testId?: string;
};

/**
 * 紧凑图标按钮（共享 neutral/icon variant）。
 *
 * 统一 focus ring、禁用态与命中尺寸；业务弹窗不得再用字体字符实现关闭/缩放/播放/移除控件
 * （design D3）。change: adopt-radix-lucide-canvas-ui 任务 6.4：底层改用共享 IconButton。
 *
 * 这里保留原生 `title` 作为可见提示而不包共享 Tooltip：弹窗打开时会 autofocus 首个可聚焦
 * 控件（通常是关闭按钮），若该控件触发 Radix Tooltip，其 dismissable layer 会成为最高层并
 * 抢占 Escape。关闭/缩放这类熟悉操作的名称已由 `label` 表达，无需额外 popup tooltip。
 */
export function DialogIconButton(props: DialogIconButtonProps) {
  return (
    <IconButton
      className={["dlg__icon-button", props.className].filter(Boolean).join(" ")}
      label={props.label}
      title={props.tooltip}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      data-testid={props.testId}
      onClick={props.onClick}
    >
      {props.icon}
    </IconButton>
  );
}

/** Footer：固定操作区。 */
export function DialogFooter(props: { children: ReactNode; className?: string }) {
  return (
    <footer className={["dlg__footer", props.className].filter(Boolean).join(" ")}>
      {props.children}
    </footer>
  );
}

/** 组合导出（design D1：Dialog.Root/Content/Header/...）。 */
export const Dialog = {
  Content: DialogContent,
  Header: DialogHeader,
  Title: DialogTitle,
  Description: DialogDescription,
  Body: DialogBody,
  Toolbar: DialogToolbar,
  Section: DialogSection,
  Footer: DialogFooter,
  MediaWorkspace: DialogMediaWorkspace,
  Stage: DialogStage,
  IconButton: DialogIconButton
};
