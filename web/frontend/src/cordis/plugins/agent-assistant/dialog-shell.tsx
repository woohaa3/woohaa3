import type { ReactNode } from "react";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@woohaa3/ui/dialogs";
import { LoadingIcon, SparklesIcon } from "@woohaa3/ui/icons";
import { UiPortalScope } from "@woohaa3/ui/primitives";
import "./style.css";

/** Keep the same dialog frame while identity and the lazy workspace become ready. */
export function AgentAssistantShell({ onClose, loadingMessage, children }: {
  onClose: () => void; loadingMessage?: string; children?: ReactNode;
}) {
  return <Dialog.Content size="lg" className="agent-assistant" ariaLabel="AI 能力中心">
    <UiPortalScope>
      <DialogHeader onClose={onClose}><div className="agent-assistant__title"><span className="agent-assistant__title-mark"><SparklesIcon size={20} /></span><DialogTitle>AI 能力中心</DialogTitle></div></DialogHeader>
      <DialogBody className="agent-assistant__workspace">
        {loadingMessage ? <div className="agent-assistant__loading"><LoadingIcon size={22} /><p>{loadingMessage}</p></div> : children}
      </DialogBody>
    </UiPortalScope>
  </Dialog.Content>;
}
