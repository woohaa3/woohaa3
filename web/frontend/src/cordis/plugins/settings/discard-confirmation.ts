import type { DialogsService } from "../../contracts.js";
import { ALERT_DIALOG_ID } from "../../services/dialogs/alert-dialog.js";

/** One owner, one pending leave decision; release never grants permission to discard. */
export function createDiscardConfirmation(dialogs: DialogsService) {
  let active: { parent: string; promise: Promise<boolean>; cancel: () => void } | null = null;
  let disposed = false;
  let sequence = 0;
  return {
    confirm(parent: string, description: string): Promise<boolean> {
      if (disposed || !dialogs.find(parent)) return Promise.resolve(false);
      if (active?.parent === parent) return Promise.resolve(false);
      active?.cancel();
      let resolve!: (value: boolean) => void;
      const promise = new Promise<boolean>((done) => { resolve = done; });
      let settled = false;
      let child: string | null = null;
      let unsubscribe = () => {};
      let disposeAction = () => {};
      const settle = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        disposeAction();
        active = null;
        const allowed = confirmed && !disposed && dialogs.find(parent) !== null;
        if (child) dialogs.close(child);
        resolve(allowed);
      };
      active = { parent, promise, cancel: () => settle(false) };
      const actionKey = `settings-discard:${parent}:${++sequence}`;
      disposeAction = dialogs.registerAlertAction(actionKey, async () => {
        settle(true);
        return { ok: true };
      });
      const check = () => {
        if (!dialogs.find(parent) || (child && !dialogs.find(child))) settle(false);
      };
      const off = dialogs.subscribe(check);
      unsubscribe = off;
      if (settled) off();
      if (!settled) {
        try {
          const opened = dialogs.open({ dialogId: ALERT_DIALOG_ID, payload: {
            title: "放弃未保存的修改？", description,
            confirmLabel: "放弃修改", cancelLabel: "继续编辑", danger: true, actionKey
          } });
          if (!opened.ok) settle(false);
          else {
            child = opened.instance.instanceId;
            if (settled) dialogs.close(child);
            else check();
          }
        } catch {
          settle(false);
        }
      }
      return promise;
    },
    dispose() { disposed = true; active?.cancel(); }
  };
}
