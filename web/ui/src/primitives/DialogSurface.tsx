/**
 * DialogSurface primitives（Radix Dialog adapter）
 * （change: adopt-radix-lucide-canvas-ui，任务 2.5 / design D4）。
 *
 * 底层 contract：暴露 Root/Overlay/Content 事件而不保存业务 stack。
 * `open` 始终由 Dialog Host stack 受控；`onOpenChange`、Escape、outside pointer 只作为
 * **close request** 交付给 Host policy（top identity / dismissible / busy 由 Host 判定），
 * adapter 不修改本地 open state，也不维护第二套权威 stack。
 *
 * 分层策略（design D4）：
 * - `DialogSurfaceRoot`：每个 stack layer 一个 Radix Dialog Root，`key` 保持 instanceId
 *   稳定，`modal` 仅由 stack top 为 true；父层 `modal=false`。
 * - `DialogSurface`：**只有 modal（top）layer** 使用 Radix Overlay/Content（focus trap、
 *   Escape、outside dismiss）；父层与 standalone（Showcase/单测）退化为普通 div，从而保持
 *   父 renderer 挂载、草稿与滚动位置保留，并由 Host 的 inert/aria-hidden 隔离。
 * - `AlertDialogSurface`：Radix Content + `role="alertdialog"`，Escape/outside 默认不产生
 *   close request（必须显式选择），复用同一 Dialog Root（Radix AlertDialog Root 不能嵌套在
 *   Dialog Root 内，行为契约由 adapter 精确表达）。
 *
 * 不使用 portal：DialogHost 已位于 `.app-theme-root` 内，inline 渲染满足主题继承，且保留
 * `.dlg-host__layer` 的父层隔离（design D4）。
 */
import {
  createContext,
  useContext,
  type ComponentPropsWithoutRef,
  type ReactNode
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

export type DialogSurfaceContextValue = {
  modal: boolean;
  dismissible: boolean;
  busy: boolean;
  /** 向 Host 发出一次 close request（是否真正关闭由 Host policy 决定）。 */
  requestClose: () => void;
  /** 打开时把焦点移入（Host 按既有 initial-target 顺序）。 */
  onOpenAutoFocus?: (event: Event) => void;
  /** 关闭后恢复焦点（Host 按 opener map / 画布 owner）。 */
  onCloseAutoFocus?: (event: Event) => void;
};

export const DialogSurfaceContext = createContext<DialogSurfaceContextValue | null>(null);

export type DialogSurfaceRootProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 只有 stack top 启用 modal/focus/dismiss 能力。 */
  modal: boolean;
  dismissible?: boolean;
  busy?: boolean;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  children: ReactNode;
};

/**
 * Host 侧的每个 stack layer Root。`onOpenChange(false)` 仅表示一次 close request；
 * Host 传入的实现负责 top identity/dismissible/busy 判定。
 */
export function DialogSurfaceRoot(props: DialogSurfaceRootProps) {
  const dismissible = props.dismissible ?? true;
  const busy = props.busy ?? false;
  const context: DialogSurfaceContextValue = {
    modal: props.modal,
    dismissible,
    busy,
    requestClose: () => {
      if (!dismissible || busy) return;
      props.onOpenChange(false);
    },
    ...(props.onOpenAutoFocus ? { onOpenAutoFocus: props.onOpenAutoFocus } : {}),
    ...(props.onCloseAutoFocus ? { onCloseAutoFocus: props.onCloseAutoFocus } : {})
  };
  // `modal` 恒定：Radix 在 `modal` 变化时会重挂内容，导致父弹窗草稿/滚动丢失
  // （change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.2）。顶层/父层差异由
  // 本 context 表达，`DialogSurface` 据此只调整 aria 与关闭行为。
  return (
    <DialogPrimitive.Root open={props.open} onOpenChange={props.onOpenChange} modal>
      <DialogSurfaceContext.Provider value={context}>{props.children}</DialogSurfaceContext.Provider>
    </DialogPrimitive.Root>
  );
}

export type DialogSurfaceProps = {
  /** 可访问名称来源（至少 ariaLabel/labelledBy 之一，由上层校验）。 */
  ariaLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  /** Content（`.dlg`）class。 */
  className?: string;
  /** Overlay class（缺省 `.dlg__overlay`）。 */
  overlayClassName?: string;
  /** 测试/定位用实例标识。 */
  instanceId?: string;
  /** busy：`aria-busy` 且禁止隐式关闭。 */
  busy?: boolean;
  /** standalone（无 Host）时点击遮罩的 close 回调。 */
  onOverlayClick?: () => void;
  children: ReactNode;
};

function staticSurface(
  props: DialogSurfaceProps,
  role: "dialog" | "alertdialog",
  options: { overlayInteractive: boolean; modal: boolean }
) {
  const busyAttr = props.busy ? { "aria-busy": "true" as const } : {};
  return (
    <div
      className={["dlg__overlay", props.overlayClassName].filter(Boolean).join(" ")}
      data-dialog-instance={props.instanceId}
      onMouseDown={options.overlayInteractive ? props.onOverlayClick : undefined}
    >
      <div
        className={[props.className, props.busy ? "dlg--busy" : ""].filter(Boolean).join(" ")}
        role={role}
        aria-modal={options.modal ? "true" : undefined}
        aria-label={props.ariaLabel}
        aria-labelledby={props.labelledBy}
        aria-describedby={props.describedBy}
        {...busyAttr}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {props.children}
      </div>
    </div>
  );
}

/** 命中应用顶部栏（Tauri 窗口横栏或浏览器浮动顶栏）时不得触发弹窗 outside 关停。 */
function isTopBarTarget(target: unknown, originalEvent?: Event): boolean {
  if (target instanceof Node) {
    const element = target instanceof Element ? target : target.parentElement;
    if (element?.closest?.(".desktop-canvas-bar, .canvas-topbar")) return true;
  }
  if (originalEvent && "clientY" in originalEvent && typeof (originalEvent as MouseEvent).clientY === "number") {
    const clientY = (originalEvent as MouseEvent).clientY;
    const desktopBar = typeof document !== "undefined" ? document.querySelector(".desktop-canvas-bar") : null;
    if (desktopBar) {
      const rect = desktopBar.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) return true;
    }
  }
  return false;
}

/**
 * 单个弹窗 surface。
 *
 * **结构稳定**是硬约束（change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.2）：
 * 嵌套确认打开后父层从 top 退化为非 top；Radix `Root` 的 `modal` 变化会重挂内容，父弹窗的
 * 草稿与滚动随之丢失。因此 Host 内始终渲染同一个 Radix `Content`（`forceMount` 保证父层
 * 也留在 DOM），只由 `aria-modal`、遮罩点击与 dismiss 判定表达「是否为当前活动层」。
 */
export function DialogSurface(props: DialogSurfaceProps) {
  const context = useContext(DialogSurfaceContext);
  const busy = props.busy ?? false;

  if (!context) {
    return staticSurface(props, "dialog", { overlayInteractive: true, modal: true });
  }

  const busyAttr = busy ? { "aria-busy": "true" as const } : {};
  const dismissBlocked = !context.dismissible || context.busy || busy;
  return (
    <DialogPrimitive.Overlay
      className={["dlg__overlay", props.overlayClassName].filter(Boolean).join(" ")}
      data-dialog-instance={props.instanceId}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (isTopBarTarget(event.target, event.nativeEvent)) return;
        // 只有 modal（top）层的遮罩点击算一次 close request；父层由 Host inert 隔离。
        if (context.modal && !dismissBlocked) context.requestClose();
      }}
    >
      <DialogPrimitive.Content
        className={[props.className, busy ? "dlg--busy" : ""].filter(Boolean).join(" ")}
        data-dialog-instance={props.instanceId}
        aria-modal={context.modal ? "true" : undefined}
        aria-label={props.ariaLabel}
        aria-labelledby={props.labelledBy}
        aria-describedby={props.describedBy}
        {...busyAttr}
        onMouseDown={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => {
          context.onOpenAutoFocus?.(event as unknown as Event);
          event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          context.onCloseAutoFocus?.(event as unknown as Event);
          event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (dismissBlocked || !context.modal) {
            event.preventDefault();
            return;
          }
          const originalEvent = (event as unknown as { detail?: { originalEvent?: Event } })?.detail?.originalEvent;
          const originalTarget = (originalEvent as { target?: unknown })?.target;
          if (isTopBarTarget(originalTarget ?? event.target, originalEvent)) {
            event.preventDefault();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (dismissBlocked || !context.modal) event.preventDefault();
        }}
      >
        {props.children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Overlay>
  );
}

/** AlertDialog 变体：在 Host 内复用 Radix Dialog surface；Escape/outside 仍只作为 close
 *  request 交给 Host policy（busy/dismissible 判定保留在 Host）。 */
export function AlertDialogSurface(props: DialogSurfaceProps) {
  const context = useContext(DialogSurfaceContext);
  const busy = props.busy ?? false;

  if (!context || !context.modal) {
    return staticSurface(props, "dialog", { overlayInteractive: !context, modal: context?.modal ?? true });
  }

  const busyAttr = busy ? { "aria-busy": "true" as const } : {};
  return (
    <DialogPrimitive.Overlay
      className={["dlg__overlay", props.overlayClassName].filter(Boolean).join(" ")}
      data-dialog-instance={props.instanceId}
    >
      <DialogPrimitive.Content
        className={[props.className, busy ? "dlg--busy" : ""].filter(Boolean).join(" ")}
        data-dialog-instance={props.instanceId}
        aria-modal="true"
        aria-label={props.ariaLabel}
        aria-labelledby={props.labelledBy}
        aria-describedby={props.describedBy}
        {...busyAttr}
        onMouseDown={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => {
          context.onOpenAutoFocus?.(event as unknown as Event);
          event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          context.onCloseAutoFocus?.(event as unknown as Event);
          event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (!context.dismissible || context.busy || busy) {
            event.preventDefault();
            return;
          }
          const originalEvent = (event as unknown as { detail?: { originalEvent?: Event } })?.detail?.originalEvent;
          const originalTarget = (originalEvent as { target?: unknown })?.target;
          if (isTopBarTarget(originalTarget ?? event.target, originalEvent)) {
            event.preventDefault();
          }
        }}
        onEscapeKeyDown={(event) => {
          // Host 拥有策略：busy / dismissible=false 时不发 close request；否则只发一次。
          if (!context.dismissible || context.busy || busy) event.preventDefault();
        }}
      >
        {props.children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Overlay>
  );
}

/** 从 Host context 读取模态策略（standalone 时返回 null）。 */
export function useDialogSurfaceContext(): DialogSurfaceContextValue | null {
  return useContext(DialogSurfaceContext);
}

type Unused = ComponentPropsWithoutRef<typeof DialogPrimitive.Content>;
export type { Unused as DialogSurfaceRadixContentProps };
