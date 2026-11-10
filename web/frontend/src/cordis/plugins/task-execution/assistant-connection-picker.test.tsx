/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AssistantConnectionPicker, type AssistantConnectionSelection } from "./assistant-connection-picker.js";

it("restores each model's legal effort while isolating a reused picker's target", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const binding = { connectionId: "connection", adapterId: "adapter", configRevision: 1, credentialEpoch: 1 };
  const service = { getDataScopeId: () => "picker-space", listConnections: async () => ({ ok: true, value: [{ ...binding, name: "助手", ready: true, authMode: "api-key", models: [{ id: "a", label: "模型 A", reasoningEfforts: ["low", "high"] }, { id: "b", label: "模型 B", reasoningEfforts: ["high"] }] }] }), catalog: vi.fn() };
  const user = { dataScopeId: "picker-space" };
  const currentUser = { getSnapshot: () => user, subscribe: () => () => {} };
  let value: AssistantConnectionSelection = { connection: binding, model: "a", reasoningEffort: "low" };
  let target = "one";
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const render = () => root.render(<AssistantConnectionPicker service={service as never} currentUser={currentUser as never} value={value} draftIdentity={target} onChange={next => { value = next; render(); }} onValidityChange={() => {}} onManage={() => {}} />);
  const choose = async (label: string) => {
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="来源与模型"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.generation-directory__model')].find(b => b.textContent?.includes(label))!.click());
  };
  try {
    await act(async () => render());
    await choose("模型 B"); expect(value).toMatchObject({ model: "b" }); expect(value.reasoningEffort).toBeUndefined();
    expect(host.textContent).toContain("新模型不支持原思考强度，已恢复默认");
    await choose("模型 A"); expect(value.reasoningEffort).toBe("low");
    target = "two"; value = { connection: binding, model: "b" }; await act(async () => render());
    await choose("模型 A"); expect(value.reasoningEffort).toBeUndefined(); expect(service.catalog).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
