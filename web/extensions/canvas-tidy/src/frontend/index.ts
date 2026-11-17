/**
 * 一键整理扩展（browser-local）
 *
 * 产品形态：**多选之后浮出一个按钮**，点一次把这批卡片整理好——消除重叠、把过大的卡片等比
 * 缩回标准尺寸、按网格重排，整批作为**一次可撤销动作**。
 *
 * 为什么不用右键菜单：画布上已经有一整套右键项（重命名/删除/对齐/分布/打组…）。整理是「看着
 * 结果点一下」的动作，浮在选区上的按钮比钻进三级菜单更直接，也让「选中了什么」和「整理哪一批」
 * 在同一处可见。右键那八项对齐/分布仍然留在宿主，本扩展不重复提供。
 *
 * 边界（三条都是刻意的）：
 * - **只改** `position` / `width` / `height`，不动层级、连线、nodeData；世界对象与导演区没有卡片
 *   坐标，明确拒绝而不是悄悄跳过一半；
 * - **只作用于当前选中**，不碰画布其余部分；
 * - 提交一律经 `canvasEdit.record`，因此整理和手动拖动共享同一条撤销时间线。
 *
 * 失败提示**不用模态弹窗**：整理是随手可重试的操作，用模态框打断用户（还得手动关掉）不划算。
 * 这里用一个自管的非阻塞提示条，几秒后自动消失。按钮本身也只在真能整理时出现（见 `tidy-plan`
 * 的 `tidyAnchorOfSelection`），所以「点了一个注定失败的按钮」这条路径本来就不存在。
 *
 * 浮层走 `canvas.overlay`：扩展自己画按钮即可，不需要宿主为它接线多选横条。
 */
import { createElement, useEffect, useSyncExternalStore } from "react";
import {
  defineExtensionPlugin,
  type CanvasEditService,
  type CanvasLocateService,
  type CanvasRuntimeService,
  type CanvasSession,
  type CanvasStoreFacade,
  type Context,
  type ExtensionFrontendDescriptor,
  type SelectionService,
  type SlotsService
} from "@woohaa3/frontend/extension-api";
import { planGroupArrange, readGroupLayout, type CanvasCommand } from "@woohaa3/contracts";
import { tidyPlanOptionsFromConfig } from "../shared.js";
import { createTidyConfigStore } from "./config-store.js";
import { metadata } from "./metadata.js";
import { planTidySelection } from "./tidy-plan.js";
import { TidyButtonHost } from "./tidy-button.js";
import "./notice.css";

/** 浮层贡献的稳定 id。 */
const OVERLAY_ID = "canvas-tidy-button";
/** 提示条自动消失时长（ms）。 */
const NOTICE_TIMEOUT_MS = 4000;

type TidyContext = Context & {
  slots: SlotsService;
  selection: SelectionService;
  canvasState: CanvasStoreFacade;
  canvasSession: CanvasSession;
  canvasRuntime: CanvasRuntimeService;
  canvasEdit: CanvasEditService;
  canvasLocate: CanvasLocateService;
};

/** 非阻塞失败提示：单条、自动消失、可手动关闭。 */
function NoticeHost({ subscribe, snapshot, dismiss }: {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => string | null;
  dismiss: () => void;
}) {
  const message = useSyncExternalStore(subscribe, snapshot, snapshot);
  return message ? createElement(TidyNotice, { message, onDismiss: dismiss }) : null;
}

function TidyNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, NOTICE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);
  return createElement("div", { className: "canvas-tidy-notice", role: "status" },
    createElement("span", null, message),
    createElement("button", {
      type: "button",
      className: "canvas-tidy-notice__close",
      onClick: onDismiss,
      title: "关闭"
    }, "×")
  );
}

export const descriptor: ExtensionFrontendDescriptor = {
  ...metadata,
  plugin: () => defineExtensionPlugin<TidyContext>((ctx) => {
    let disposed = false;
    ctx.effect(() => () => { disposed = true; }, "canvas-tidy-dispose");

    // 配置真源在宿主（`extensions.canvas-tidy.*`）：读 `/api/settings`，写完回填同一份快照。
    const config = createTidyConfigStore();
    ctx.effect(() => () => config.dispose(), "canvas-tidy-config");
    // 启动即读一次：第一次点整理时就不必等网络。
    void config.refresh();
    // 设置页的界面由**宿主**按 `Config` 声明自动生成（设置 → 插件 → 一键整理 → 配置项），
    // 本扩展不注册 `settings.plugin-config` 面板：同一批键画两遍就是两套体系。
    //
    // 配置改动怎么传到这里：宿主的设置 API 没有推送通道，所以每次点「一键整理」前读一次
    // （见 `runTidy`）。那一次读取用的是改动前的值，紧接着的整理会慢一拍；下次点击即生效。
    // 之所以接受这个代价：整理是低频动作，而常驻轮询设置接口的代价比慢一拍大得多。
    ctx.effect(() => {
      // 页面重新可见时补一次（用户可能刚从设置页切回来）。
      const onVisible = () => { if (document.visibilityState === "visible") void config.refresh(); };
      document.addEventListener("visibilitychange", onVisible);
      return () => document.removeEventListener("visibilitychange", onVisible);
    }, "canvas-tidy-config-visibility");

    // 失败提示的状态由扩展自己持有：同一时刻至多一条，新消息替换旧的。
    let noticeListeners: Array<() => void> = [];
    let noticeMessage: string | null = null;
    const notify = () => { for (const listener of noticeListeners) listener(); };
    const report = (reason: string): void => {
      noticeMessage = reason;
      notify();
    };
    const dismiss = (): void => { noticeMessage = null; notify(); };

    const removeNotice = ctx.slots.register("canvas.overlay", {
      id: `${OVERLAY_ID}-notice`,
      owner: metadata.extensionId,
      // 提示条压在按钮之上，但不进入弹窗层级。
      priority: 31,
      render: () => createElement(NoticeHost, {
        subscribe: (listener: () => void) => {
          noticeListeners.push(listener);
          return () => { noticeListeners = noticeListeners.filter(entry => entry !== listener); };
        },
        snapshot: () => noticeMessage,
        dismiss
      })
    });

    const removeOverlay = ctx.slots.register("canvas.overlay", {
      id: OVERLAY_ID,
      owner: metadata.extensionId,
      // 高于宿主节点横条（25），两者不会同时出现，但整理时按钮应压在其它浮层之上。
      priority: 30,
      render: props => createElement(TidyButtonHost, {
        // 直接读服务而不是只用 slot props：按钮需要选区与本地视口，两者不在 slot props 里。
        canvasState: ctx.canvasState,
        selection: ctx.selection,
        session: ctx.canvasSession,
        runtime: ctx.canvasRuntime,
        onTidy: () => { runTidy(props.revision); },
        onArrangeGroups: groupIds => { runGroupArrange(groupIds); }
      })
    });

    /**
     * 执行一次整理。
     *
     * 走的是与按钮门禁同一个 `planTidySelection`：按钮出现就意味着这里能成功，因此
     * `!plan.ok` 只可能是选区在点击与执行之间变了（另一处删掉了节点），如实提示即可。
     *
     * 排布参数来自宿主配置（间距、列距倍数、是否缩尺寸与容差）；配置还没读到时用声明里的
     * default——与「没有配置项」时的行为一致。
     */
    function runTidy(_revision: number): void {
      if (disposed) return;
      const canvas = ctx.canvasState.getWorkingCanvas();
      if (!canvas || !ctx.canvasSession.isWritable()) return;
      const selected = ctx.selection.getSnapshot().nodeIds;
      const settings = config.getSnapshot().values;
      const plan = planTidySelection(canvas, selected, tidyPlanOptionsFromConfig(settings));
      if (!plan.ok) { report(plan.reason); return; }
      // 无净变化：不落一条空的历史记录，也不假装"整理过了"。
      if (plan.commands.length === 0) return;
      const canvasId = canvas.id;
      void ctx.canvasEdit.record(plan.commands, "整理所选作品")
        .then(result => {
          if (!result.ok) {
            if (!disposed && ctx.canvasState.getWorkingCanvas()?.id === canvasId) report(result.reason);
            return;
          }
          // 可选：整理后把视口定位到这批卡片，让用户立刻看到结果。
          if (settings.revealAfterTidy && !disposed) ctx.canvasLocate.locateNodes(selected, { select: false, fit: true });
        })
        .catch(() => {
          if (!disposed && ctx.canvasState.getWorkingCanvas()?.id === canvasId) report("整理失败，请检查画布连接");
        });
      // 顺带刷新一次配置：手工改过配置文件的话，这次整理就用最新值。
      void config.refresh();
    }

    /**
     * 只整理选中组的内部成员（宫格），组与画布其余卡片不动。
     *
     * 多个组一起整理时合并成**一个**批次、一条撤销记录：用户点的是「整理这些组内部」这一个动作，
     * 撤销就该一次回到原样，而不是要求连按 N 次撤销。
     *
     * 排布规则取 contracts 的 `planGroupArrange`——与宿主组卡片顶部栏的三个按钮**同一份实现**，
     * 所以在哪点都不会排出两种结果。默认不改组内排布，这是用户显式要求的入口。
     */
    function runGroupArrange(groupIds: readonly string[]): void {
      if (disposed || groupIds.length === 0) return;
      const canvas = ctx.canvasState.getWorkingCanvas();
      if (!canvas || !ctx.canvasSession.isWritable()) return;
      const commands: CanvasCommand[] = [];
      let label = "整理 2D 组内部";
      for (const groupId of groupIds) {
        const layout = readGroupLayout(canvas, groupId);
        // 单个组失效（成员全被删/数据坏了）时如实报出，不静默跳过半个动作。
        if (!layout.ok) { report(layout.reason); return; }
        const plan = planGroupArrange(layout.layout, "grid");
        if (!plan.ok) { report(plan.reason); return; }
        commands.push(...plan.commands);
        if (groupIds.length === 1) label = plan.label;
      }
      if (commands.length === 0) return;
      const canvasId = canvas.id;
      void ctx.canvasEdit.record(commands, label)
        .then(result => {
          if (!result.ok && !disposed && ctx.canvasState.getWorkingCanvas()?.id === canvasId) report(result.reason);
        })
        .catch(() => {
          if (!disposed && ctx.canvasState.getWorkingCanvas()?.id === canvasId) report("整理组内部失败，请检查画布连接");
        });
    }

    return () => {
      removeOverlay();
      removeNotice();
      noticeListeners = [];
      noticeMessage = null;
    };
  }, {
    name: metadata.extensionId,
    inject: ["slots", "selection", "canvasState", "canvasSession", "canvasRuntime", "canvasEdit", "canvasLocate"]
  })
};
