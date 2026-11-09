import { expect, it, vi } from "vitest";
import { DialogService } from "../../services/dialogs/service.js";
import { alertDefinition, ALERT_DIALOG_ID } from "../../services/dialogs/alert-dialog.js";
import { createDiscardConfirmation } from "./discard-confirmation.js";
function fixture() {
 const dialogs = new DialogService();
 dialogs.registerDialog("parent", { definition: alertDefinition });
 dialogs.registerDialog(ALERT_DIALOG_ID, { definition: alertDefinition });
 const p = dialogs.open({ dialogId: "parent", payload: { title: "settings", description: "settings" } });
 if (!p.ok) throw Error("parent");
 return { dialogs, parent: p.instance.instanceId, controller: createDiscardConfirmation(dialogs) };
}
it("deduplicates and closes its busy child on confirmation", async () => {
 const { dialogs, parent, controller } = fixture();
 const result = controller.confirm(parent, "discard");
 expect(await controller.confirm(parent, "again")).toBe(false);
 const child = dialogs.top()!;
 const key = (child.payload as { actionKey: string }).actionKey;
 dialogs.setBusy(child.instanceId, true);
 await dialogs.resolveAlertAction(key)!();
 expect(await result).toBe(true);
 expect(dialogs.top()?.instanceId).toBe(parent);
 expect(dialogs.resolveAlertAction(key)).toBeNull();
});
it("cancel permits retry; parent removal closes child and resolves false", async () => {
 const { dialogs, parent, controller } = fixture();
 const first = controller.confirm(parent, "discard");
 dialogs.close(dialogs.top()!.instanceId);
 expect(await first).toBe(false);
 const second = controller.confirm(parent, "retry");
 dialogs.close(parent);
 expect(await second).toBe(false);
 expect(dialogs.top()).toBeNull();
});
it("dispose rejects late actions and cleans up", async () => {
 const { dialogs, parent, controller } = fixture();
 const result = controller.confirm(parent, "discard");
 const key = (dialogs.top()!.payload as { actionKey: string }).actionKey;
 const action = dialogs.resolveAlertAction(key)!;
 controller.dispose();
 await action();
 expect(await result).toBe(false);
 expect(dialogs.resolveAlertAction(key)).toBeNull();
 expect(dialogs.top()?.instanceId).toBe(parent);
});
it("missing alert registration fails safely", async () => {
 const dialogs = new DialogService();
 dialogs.registerDialog("parent", { definition: alertDefinition });
 const p = dialogs.open({ dialogId: "parent", payload: { title: "p", description: "p" } });
 if (!p.ok) throw Error("parent");
 const controller = createDiscardConfirmation(dialogs);
 expect(await controller.confirm(p.instance.instanceId, "discard")).toBe(false);
});

it("cleans a synchronous subscription callback without leaking listeners", async () => {
 const { dialogs, parent, controller } = fixture();
 const subscribe = dialogs.subscribe;
 const off = vi.fn();
 vi.spyOn(dialogs, "subscribe").mockImplementation((listener) => {
   dialogs.close(parent);
   listener(dialogs.getSnapshot());
   const unsubscribe = subscribe(listener);
   return () => { off(); unsubscribe(); };
 });
 expect(await controller.confirm(parent, "discard")).toBe(false);
 expect(off).toHaveBeenCalledOnce();
 expect(dialogs.top()).toBeNull();
});
it("parent removal during open removes the just-opened child", async () => {
 const { dialogs, parent, controller } = fixture();
 const open = dialogs.open.bind(dialogs);
 vi.spyOn(dialogs, "open").mockImplementation((request) => {
   const result = open(request);
   dialogs.close(parent);
   return result;
 });
 expect(await controller.confirm(parent, "discard")).toBe(false);
 expect(dialogs.top()).toBeNull();
});
