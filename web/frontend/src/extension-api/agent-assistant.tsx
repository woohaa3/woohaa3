import type { AppRouterService } from "../cordis/navigation/app-router.js";
import { Button } from "../shared/ui/index.js";
/** Carries only an entry kind across page disposal, never credentials or target drafts. */
export function openAgentAssistant(router: AppRouterService, kind: "login" | "installed" | "api-key") {
  if (router.getLocation().page === "canvas") {
    globalThis.dispatchEvent(new CustomEvent("woohaa3-open-agent-assistant", { detail: { kind } }));
  } else {
    sessionStorage.setItem("woohaa3-agent-assistant-entry", kind);
    router.navigate({ page: "canvas" });
  }
}
export function AgentAssistantSettingsLink({ onOpen }: { onOpen: () => void }) {
  return <div><p>本地 Agent 与 MCP 在「本地助手」中管理；API 和账号授权在「服务连接」中管理。</p><Button onClick={onOpen}>打开 AI 助手</Button></div>;
}
