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
  return <div><p>个人账号、已安装工具和 API Key 在 AI 助手中管理。</p><Button onClick={onOpen}>打开 AI 助手</Button></div>;
}
