/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DirectorCharacterToolbar } from "./director-character-toolbar.js";
const mocks = vi.hoisted(() => ({ create: vi.fn(async () => {}), remote: {}, edit: {}, session: { isWritable: () => true } }));
vi.mock("./director-character-create.js", () => ({ createDirectorCharacter: mocks.create }));
vi.mock("../../react.js", () => ({ useOptionalService: (key: string) => ({ canvasRemote: mocks.remote, canvasEdit: mocks.edit, canvasSession: mocks.session })[key as "canvasRemote"] }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; mocks.create.mockClear(); });
it("shows exactly two direct factory actions and disables both read-only", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); dispose = () => act(() => root.unmount());
  await act(async () => root.render(<DirectorCharacterToolbar canvasId="c" nodeId="a" areaId="a" writable />));
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.map(b => b.textContent)).toEqual(["胶囊人", "骨架人"]);
  await act(async () => buttons[0].click());
  await act(async () => buttons[1].click());
  expect(mocks.create.mock.calls.map(call => (call as unknown as [{kind:string}])[0].kind)).toEqual(["capsule", "humanoid"]);
  await act(async () => root.render(<DirectorCharacterToolbar canvasId="c" nodeId="a" areaId="a" writable={false} />));
  expect(buttons.every(b => b.disabled)).toBe(true);
  await act(async () => buttons[0].click()); expect(mocks.create).toHaveBeenCalledTimes(2);
});
