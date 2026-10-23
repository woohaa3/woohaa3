import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Tooltip } from "../../../shared/ui/Tooltip.js";
import { useOptionalService, useService } from "../../react.js";
import { agentDirectory } from "../../services/assistant-execution/directory.js";
import { ASSISTANT_SETUP_TOOLTIP } from "../../ui/assistant-execution/model-selector.js";

const noopSubscribe = () => () => undefined;

/** Uses the same scoped directory as composers; loading/failure is never an empty account. */
export function AssistantSetupTooltip({ children }: { children: ReactNode }) {
  const service = useService("agentConversationService");
  const user = useOptionalService("currentUser");
  const session = useOptionalService("canvasSession");
  const dialogs = useOptionalService("dialogs");
  const namespace = useSyncExternalStore(user?.subscribe ?? service.subscribe ?? noopSubscribe,
    () => user ? user.getSnapshot()?.dataScopeId : service.getDataScopeId?.());
  const phase = useSyncExternalStore(session?.subscribe ?? noopSubscribe, () => session?.getStatus().phase);
  const dialogOpen = useSyncExternalStore(dialogs?.subscribe ?? noopSubscribe, () => Boolean(dialogs?.getSnapshot().stack.length));
  const directory = agentDirectory(service, namespace ?? "unresolved");
  const snapshot = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
  const [dismissedScope, setDismissedScope] = useState<string | null>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  useEffect(() => {
    if (namespace && phase === "ready") void directory.load();
  }, [directory, namespace, phase]);
  const empty = Boolean(namespace && snapshot.ready && !snapshot.loadingMessage && !snapshot.error && !snapshot.connections.length);
  const guide = empty && !dialogOpen && dismissedScope !== namespace;
  return <Tooltip content={empty ? ASSISTANT_SETUP_TOOLTIP : "AI 助手"} side="top" align="end"
    open={!dialogOpen && (guide || hoverOpen)}
    onOpenChange={open => { setHoverOpen(open); if (!open && guide) setDismissedScope(namespace!); }}>
    {children}
  </Tooltip>;
}
