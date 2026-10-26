import { lazy, Suspense, useSyncExternalStore, useMemo } from "react";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { SparklesIcon } from "../../../shared/ui/icons.js";
import { objectPayload } from "../../services/dialogs/registry.js";
import { createBackendSettingsStore } from "../settings/backend-settings-store.js";
import type { SettingsRemote } from "../../services/settings-remote.js";
import { agentDirectory } from "../../services/agent-directory.js";
import { AssistantSetupTooltip } from "./setup-tooltip.js";
import { installAssistantFirstUse } from "./first-use.js";

export const AGENT_ASSISTANT_DIALOG_ID = "agent-assistant";
type Payload = { canvasId?: string; nodeId?: string; kind?: string; page?: "add"; connectionId?: string; section?: "generation-history" | "diagnostics" };
const AgentAssistant = lazy(() => import("./assistant.js").then((module) => ({ default: module.AgentAssistant })));

export function agentAssistantExtension(): Plugin.Function<void> {
  return definePlugin((ctx: Context) => {
    const refreshDirectory = () => {
      const namespace = ctx.get("currentUser")?.getSnapshot()?.dataScopeId;
      if (namespace) void agentDirectory(ctx.agentConversationService, namespace).load(true);
    };
    const remote = ctx.get("settingsRemote" as never) as SettingsRemote | undefined;
    const settingsStore = remote ? createBackendSettingsStore({
      fetchSnapshot: () => remote.fetchSnapshot(),
      async write(values) {
        const result = await remote.write(values);
        if (result.ok) {
          (ctx.get("taskCatalog" as never) as { invalidate?: () => void } | undefined)?.invalidate?.();
          refreshDirectory();
        }
        return result;
      }
    }) : undefined;
    const unregister = ctx.dialogs.registerDialog(AGENT_ASSISTANT_DIALOG_ID, {
      definition: { singleton: true, dismissible: true, size: "lg", validatePayload: objectPayload<Payload>(AGENT_ASSISTANT_DIALOG_ID, (value) => ({ ...(typeof value.canvasId === "string" ? { canvasId: value.canvasId } : {}), ...(typeof value.nodeId === "string" ? { nodeId: value.nodeId } : {}), ...(typeof value.kind === "string" ? { kind: value.kind } : {}), ...(typeof value.connectionId === "string" ? { connectionId: value.connectionId } : {}), ...(["generation-history", "diagnostics"].includes(String(value.section)) ? { section: value.section as Payload["section"] } : {}), ...(value.page === "add" ? { page: "add" as const } : {}) })) },
      renderer: ({ instance, requestClose }) => {
        const user = ctx.get("currentUser");
        const scope = useSyncExternalStore(user?.subscribe ?? (() => () => {}), () => user ? user.getSnapshot()?.dataScopeId ?? null : "local");
        const payload = useMemo(() => ({ canvasId: ctx.get("canvasScope")?.canvasId(), ...(instance.payload as Payload) }), [instance.payload]);
        if (scope === null) return <p>正在确认用户数据空间…</p>;
        return <Suspense fallback={<p>正在打开 AI 助手…</p>}><AgentAssistant key={`${instance.instanceId}:${scope}:${payload.canvasId ?? ""}`} service={ctx.agentConversationService} payload={payload} onClose={requestClose} onHistoryClose={() => ctx.dialogs.requestClose(instance.instanceId).closed} settingsStore={settingsStore} onConfigurationSaved={refreshDirectory} /></Suspense>;
      }
    });
    // 面板主操作：AI 助手排最前（priority 低于其它入口），并使用 primary 实底图标。
    const remove = ctx.slots.register("canvas.toolbar-action", { id: AGENT_ASSISTANT_DIALOG_ID, owner: AGENT_ASSISTANT_DIALOG_ID, priority: 0, label: "AI 助手", icon: SparklesIcon, tone: "primary", tooltip: AssistantSetupTooltip, onActivate: () => { ctx.canvasNavigation.openDialog({ dialogId: AGENT_ASSISTANT_DIALOG_ID, payload: {} }); } });
    const open = (event: Event) => { ctx.canvasNavigation.openDialog({ dialogId: AGENT_ASSISTANT_DIALOG_ID, payload: (event as CustomEvent).detail ?? {} }); };
    globalThis.addEventListener("woohaa3-open-agent-assistant", open);
    const pending = sessionStorage.getItem("woohaa3-agent-assistant-entry");
    if (pending) {
      sessionStorage.removeItem("woohaa3-agent-assistant-entry");
      ctx.canvasNavigation.openDialog({ dialogId: AGENT_ASSISTANT_DIALOG_ID, payload: { kind: pending } });
    }
    const user = ctx.get("currentUser");
    const session = ctx.get("canvasSession");
    const stopFirstUse = user && session ? installAssistantFirstUse({
      service: ctx.agentConversationService, user, session, dialogs: ctx.dialogs,
      open: () => ctx.canvasNavigation.openDialog({ dialogId: AGENT_ASSISTANT_DIALOG_ID, payload: { page: "add" } }),
    }) : undefined;
    ctx.effect(() => () => { globalThis.removeEventListener("woohaa3-open-agent-assistant", open);
      stopFirstUse?.();
      for (const instance of ctx.dialogs.getSnapshot().stack) if (instance.dialogId === AGENT_ASSISTANT_DIALOG_ID) ctx.dialogs.close(instance.instanceId);
      remove(); unregister(); }, "agent-assistant");
  }, { name: AGENT_ASSISTANT_DIALOG_ID, inject: ["slots", "dialogs", "canvasNavigation", "agentConversationService"] });
}
