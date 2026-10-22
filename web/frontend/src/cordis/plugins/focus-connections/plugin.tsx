/**
 * 聚焦连接圆点 Plugin
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 7.2 / design D3）。
 *
 * 图片与 model3d/composite-asset 聚焦期间，在公共标题栏显示直接前序/后序圆点。只读；不改变
 * selection/拓扑，不提交命令。跟随 Navigation 的聚焦 mode。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { FocusConnectionsBar } from "./bar.js";
import { definePlugin } from "../../plugin.js";

export const FOCUS_CONNECTIONS_PLUGIN_ID = "focus-connections";

export function focusConnectionsExtension(): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const removers = (["incoming", "outgoing"] as const).map(side => ctx.slots.register("canvas.focus-header", {
        id: `${FOCUS_CONNECTIONS_PLUGIN_ID}-${side}`,
        owner: FOCUS_CONNECTIONS_PLUGIN_ID,
        priority: 5,
        position: side === "incoming" ? "before-title" : "after-title",
        render: ({ nodeId }) => <FocusConnectionsBar focusNodeId={nodeId} side={side} />
      }));
      ctx.effect(() => () => removers.forEach(remove => remove()), "focus-connections-header");
    },
    { name: FOCUS_CONNECTIONS_PLUGIN_ID, inject: ["slots"] }
  );
}
