/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { $getRoot, BLUR_COMMAND, getNearestEditorFromDOMNode } from "lexical";
import { MentionEditor } from "../mention/MentionEditor.js";
import { ExecutionPanel } from "./ExecutionPanel.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });

it.each(["compact", "expanded"] as const)("%s settings preserve empty/nonempty prompt, parameters and target isolation", async presentation => {
 for (const value of ["", "生成一张风景图片"]) {
  const el = document.createElement("div"); document.body.append(el);
  const root = createRoot(el);
  function Panel() {
    const [data, setData] = useState({panelPrompt: value, parameters: {model:"m", size:"small"}});
    return <><ExecutionPanel taskKind="image-generation" surface="dock" presentation={presentation} data={data}
      modelConfig={{defaultModel:"m", modelOptions:[{value:"m",label:"M"}], parameterSchemaByModel:{m:[{key:"size",label:"尺寸",type:"select",options:[{value:"small",label:"小"},{value:"large",label:"大"}]}]}}}
      promptEditorSlot={({value,onChange}) => <MentionEditor value={value} onChange={onChange} candidates={[]} />}
      onChange={patch => setData(previous => ({...previous,...patch,parameters:{...previous.parameters,...patch.parameters}}))} />
      <button data-outside>外部</button></>;
  }
  try {
    await act(async () => root.render(<Panel />));
    const input = el.querySelector<HTMLElement>('[contenteditable]')!;
    const editor = getNearestEditorFromDOMNode(input)!;
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => { input.focus(); editor.update(() => { $getRoot().selectEnd(); }); });
      const trigger = el.querySelector<HTMLButtonElement>('[aria-label="生成参数"]')!;
      await act(async () => { trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.focus(); trigger.click(); });
      await act(async () => {});
      expect(document.querySelector(".mc-panel__settings-menu")).not.toBeNull();
      expect(input.textContent).toBe(value);
      // A blur normalization can finish after Radix has focused its first control.
      await act(async () => { editor.dispatchCommand(BLUR_COMMAND, new FocusEvent("blur")); });
      expect(document.querySelector(".mc-panel__settings-menu")).not.toBeNull();
      const large = document.querySelector<HTMLButtonElement>('.mc-panel__settings-menu [aria-label="大"]')!;
      await act(async () => { large.click(); });
      expect(document.querySelector('.mc-panel__settings-menu [aria-label="大"]')?.getAttribute("data-state")).toBe("on");
      const outside = el.querySelector<HTMLButtonElement>('[data-outside]')!;
      await act(async () => { outside.dispatchEvent(new Event("pointerdown", { bubbles: true })); outside.focus(); });
      expect(document.querySelector(".mc-panel__settings-menu")).toBeNull();
    }
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="生成参数"]')!.click());
    expect(document.querySelector(".mc-panel__settings-menu")).not.toBeNull();
    await act(async () => root.render(<Panel key="other-node" />));
    expect(document.querySelector(".mc-panel__settings-menu")).toBeNull();
  } finally { await act(async () => root.unmount()); el.remove(); }
 }
});
