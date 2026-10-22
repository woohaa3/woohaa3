import type { AgentConversationService } from "../../contract/agent-conversation.js";
import type { CurrentUserService } from "../../services/current-user.js";
import type { CanvasSession } from "../../services/canvas-session.js";
import type { DialogsService } from "../../contracts.js";
import { agentDirectory } from "../../services/assistant-execution/directory.js";

const seenByService = new WeakMap<object, Set<string>>();
export const assistantFirstUseKey = (scope: string) => `woohaa3:assistant-first-use:${encodeURIComponent(scope)}`;

/** First successful directory read decides onboarding; closing it is respected across launches. */
export function installAssistantFirstUse(options: {
  service: AgentConversationService;
  user: Pick<CurrentUserService, "getSnapshot" | "subscribe">;
  session: Pick<CanvasSession, "getStatus" | "subscribe">;
  dialogs: Pick<DialogsService, "getSnapshot" | "subscribe">;
  open(): { ok: boolean };
}) {
  const seen = seenByService.get(options.service) ?? new Set<string>();
  seenByService.set(options.service, seen);
  const hasSeen = (scope: string) => {
    if (seen.has(scope)) return true;
    try { return globalThis.localStorage?.getItem(assistantFirstUseKey(scope)) === "seen"; }
    catch { return false; }
  };
  const remember = (scope: string) => {
    seen.add(scope);
    try { globalThis.localStorage?.setItem(assistantFirstUseKey(scope), "seen"); }
    catch { /* Keep the in-session record when browser storage is unavailable. */ }
  };
  let disposed = false;
  let queued = false;
  let directory: ReturnType<typeof agentDirectory> | undefined;
  let boundScope: string | undefined;
  let attemptedScope: string | undefined;
  let unsubscribeDirectory: (() => void) | undefined;
  const schedule = () => {
    if (disposed || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed) return;
      const scope = options.user.getSnapshot()?.dataScopeId;
      if (boundScope !== scope) {
        unsubscribeDirectory?.();
        directory = undefined;
        boundScope = scope;
      }
      if (!scope || hasSeen(scope) || options.session.getStatus().phase !== "ready") return;
      if (!directory) {
        directory = agentDirectory(options.service, scope);
        unsubscribeDirectory = directory.subscribe(schedule);
        void directory.load();
      }
      const snapshot = directory.getSnapshot();
      if (!snapshot.ready || snapshot.loadingMessage || snapshot.error) return;
      const stack = options.dialogs.getSnapshot().stack;
      if (snapshot.connections.length || stack.some(dialog => dialog.dialogId === "agent-assistant")) {
        remember(scope);
        return;
      }
      if (stack.length || attemptedScope === scope) return;
      // Dialog subscriptions may fire synchronously; reserve this attempt before opening it.
      attemptedScope = scope;
      seen.add(scope);
      if (options.open().ok) remember(scope);
      else seen.delete(scope);
    });
  };
  const unsubscribers = [options.user.subscribe(schedule), options.session.subscribe(schedule), options.dialogs.subscribe(schedule)];
  schedule();
  return () => {
    disposed = true;
    unsubscribeDirectory?.();
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
