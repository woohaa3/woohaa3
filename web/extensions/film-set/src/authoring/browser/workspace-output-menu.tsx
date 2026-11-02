import { useState, type ReactNode } from "react";
import { Button, Popover } from "@woohaa3/ui/primitives";
import { DownloadIcon } from "@woohaa3/ui/icons";

/** Closing output settings preserves capture/export state and ongoing operations. */
export function FilmSetOutputMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen} keepMounted side="top" align="end"
    className="film-set-output-menu" label="镜头输出"
    trigger={<Button size="sm" tone="ghost" icon={<DownloadIcon size={16} />}>输出</Button>}>
    <div data-canvas-scrollable="true" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <h3>镜头输出</h3>
      {children}
    </div>
  </Popover>;
}
