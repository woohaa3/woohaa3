/**
 * Dialog Host 组件（change: add-frontend-dialog-system，任务 3.1 / 3.2 / 3.3 / design D3/D4/D5；
 *  change: adopt-frontend-cordis-plugin-runtime 改为消费注入的 Dialogs Service；
 *  change: adopt-radix-lucide-canvas-ui 任务 6.1–6.3：每层接入受控 DialogSurface Root，
 *  仅 top layer 启用 modal/dismiss，删除被 Radix 替代的 document-level Tab/Escape 实现）。
 *
 * 挂载在 Frontend 根，是宿主级弹窗的唯一渲染与事件 owner：
 * - 从 Dialogs Service 读取有序 stack；
 * - 按 Service 的 renderer registry 渲染每个实例（未注册则不渲染、不崩溃）；
 * - 父弹窗保留挂载以保存草稿/滚动，但仅顶部可交互（design D3）；
 * - Escape、outside pointer、open autofocus 与 close autofocus 接到 Host policy：
 *   top identity / dismissible / busy 由 Host 判定；opener map 与 close policy 保留。
 *
 * 本组件不读写 bridge/canvas 业务状态；画布输入门禁由 Input Scope Service 提供。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { type DialogHostSnapshot } from "./host-store.js";
import { type DialogRendererProps } from "./renderer-registry.js";
import { captureFocus, focusInitial, restoreFocus } from "./focus.js";
import { DialogSurfaceRoot } from "../../../shared/ui/DialogSurface.js";
import type { DialogInstance } from "./types.js";
import type { DialogsService } from "../../contracts.js";

/** 订阅 Host 快照；未变更时返回同一引用（service 保证）。 */
export function useDialogHost(dialogs: DialogsService): DialogHostSnapshot {
  return useSyncExternalStore(dialogs.subscribe, dialogs.getSnapshot, dialogs.getSnapshot);
}

export type DialogHostProps = {
  /** 注入的 Dialog Service（必填；缺依赖按 required-service 规则失败）。 */
  dialogs: DialogsService;
  /** 覆盖某个实例的渲染（测试/定制）；返回 `null` 表示不渲染。 */
  renderDialog?: (props: DialogRendererProps) => React.ReactNode;
};

export function DialogHost({ dialogs, renderDialog }: DialogHostProps) {
  const snapshot = useDialogHost(dialogs);
  const stack = snapshot.stack;
  const topInstanceId = stack.length > 0 ? stack[stack.length - 1]!.instanceId : null;

  // 焦点：记录每个新顶部实例打开前的 opener，栈变空时恢复。
  const openers = useRef<Map<string, Element | null>>(new Map());
  const prevTop = useRef<string | null>(null);

  useLayoutEffect(() => {
    const previous = prevTop.current;
    prevTop.current = topInstanceId;
    if (topInstanceId && topInstanceId !== previous) {
      if (!openers.current.has(topInstanceId)) {
        openers.current.set(topInstanceId, captureFocus(document));
      }
    } else if (!topInstanceId && previous) {
      const opener = openers.current.get(previous) ?? null;
      openers.current.delete(previous);
      restoreFocus(document, opener);
    }
  }, [topInstanceId]);

  // 清理已关闭实例的 opener 记录。
  useEffect(() => {
    const live = new Set(stack.map((instance) => instance.instanceId));
    for (const key of [...openers.current.keys()]) {
      if (!live.has(key)) openers.current.delete(key);
    }
  }, [stack]);

  const renderOne = useCallback(
    (instance: DialogInstance, isTop: boolean) => {
      /** 所有用户关闭来源（Header X / 业务 requestClose / Escape / 遮罩）共用同一 guard 通路。 */
      const requestCloseForInstance = (instanceId: string) => {
        const top = dialogs.top();
        if (!top || top.instanceId !== instanceId) return;
        if (!top.dismissible || top.busy) return;
        dialogs.requestClose(instanceId);
      };
      const api: DialogRendererProps = {
        instance,
        requestClose: () => {
          requestCloseForInstance(instance.instanceId);
        },
        setBusy: (busy: boolean) => dialogs.setBusy(instance.instanceId, busy),
        replace: (payload: unknown) => dialogs.replace(payload, instance.instanceId)
      };
      const content = renderDialog
        ? renderDialog(api)
        : renderRegistered(dialogs, instance, api);
      // 非顶部：不可交互且不被辅助技术遍历（design D3）。
      // React 18 的 DOM 类型不含 `inert`，用 spread 传入并显式声明。
      const inertProps = isTop ? {} : ({ inert: "" } as Record<string, string>);
      return (
        <div
          key={instance.instanceId}
          className="dlg-host__layer"
          data-dialog-layer={instance.instanceId}
          aria-hidden={isTop ? undefined : "true"}
          {...inertProps}
        >
          <DialogSurfaceRoot
            open
            onOpenChange={(next) => {
              // adapter 只发一次 close request；这里按 Host policy 判定 top/dismissible/busy/guard。
              if (next) return;
              requestCloseForInstance(instance.instanceId);
            }}
            modal={isTop}
            dismissible={instance.dismissible}
            busy={instance.busy}
            onOpenAutoFocus={(event) => {
              // 使用既有 initial-target 顺序：把焦点移入当前 layer 的 dialog surface。
              const container = document.querySelector(`[data-dialog-instance="${instance.instanceId}"]`);
              if (container) focusInitial(container);
              event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              // Host 按 instance identity 恢复 opener 或画布 keyboard owner；阻止 Radix 默认回到 trigger。
              event.preventDefault();
            }}
          >
            {content}
          </DialogSurfaceRoot>
        </div>
      );
    },
    [dialogs, renderDialog]
  );

  if (stack.length === 0) return null;
  return (
    <div className="dlg-host">
      {stack.map((instance, index) => renderOne(instance, index === stack.length - 1))}
    </div>
  );
}

function renderRegistered(dialogs: DialogsService, instance: DialogInstance, api: DialogRendererProps): React.ReactNode {
  const Renderer = dialogs.resolveRenderer(instance.dialogId);
  if (!Renderer) return null;
  return <Renderer {...api} />;
}
