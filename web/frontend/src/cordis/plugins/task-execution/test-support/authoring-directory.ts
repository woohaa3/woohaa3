import type { AgentConnectionView } from "@woohaa3/contracts";
import type { AuthoringGenerationProps } from "../../../contract/authoring.js";
import { agentDirectory } from "../../../services/assistant-execution/directory.js";
/** Build the real read-only connection view alongside each owner projection in UI integration fixtures. */
export function supplyAuthoringDirectory(props: AuthoringGenerationProps) {
  const service = props.agentConversation?.service;
  if (!service) return;
  const selection = props.sourceSelection;
  service.listConnections = async () => ({ ok: true, value: (selection?.connections ?? []).map(c => ({
    connectionId: c.connectionId, adapterId: selection?.selectedSourceId || "sdk", name: c.label,
    models: c.models, ready: c.ready, reason: c.reason, authMode: c.modelSelection === "tool-default" ? "local-login" : "api-key",
    configRevision: 1, credentialEpoch: 1, capabilities: { tools: true, targets: ["model3d", "world", "canvas-group", "text"], discussion: true, models: "remote" },
  })) as unknown as AgentConnectionView[] });
  const directory = agentDirectory(service, service.getDataScopeId?.() ?? "page");
  directory.invalidate();
  void directory.load();
}
