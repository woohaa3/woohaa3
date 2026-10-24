/** @vitest-environment jsdom */
// 验证指针时序、槽位成员与弹层状态；不创建渲染上下文或截图。
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {ReactNode} from "react";
import {ToolSlotButton} from "./tool-slot-button.js";
import type {ToolMember, ToolSlot} from "./toolbar-slots.js";
import {TOOL_SLOTS} from "./toolbar-slots.js";

vi.mock("./ui/Popover.js",()=>({Popover:({open,children,onOpenChange}:{open:boolean;children:ReactNode;onOpenChange:(open:boolean)=>void})=>
  open?<div data-group-menu onKeyDown={event=>{if(event.key==="Escape") {event.stopPropagation();onOpenChange(false);}}}>{children}</div>:null}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

const slotAt = (index: number): ToolSlot => TOOL_SLOTS.find(slot => slot.index === index)!;
/** 槽 1：矩形/椭圆/单行/单列四个成员。 */
const marqueeSlot = slotAt(1);
const marqueeMembers = marqueeSlot.members;
const member = (id: string): ToolMember => marqueeMembers.find(candidate => candidate.id === id)!;

function setup(props: Partial<Parameters<typeof ToolSlotButton>[0]> = {}) {
  const chosen = vi.fn(), pressed = vi.fn(), container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (next: Partial<Parameters<typeof ToolSlotButton>[0]> = {}) => act(() => root.render(
    <ToolSlotButton slot={marqueeSlot} shown={member("rectMarquee")} active={false} onChoose={chosen}
      onPress={pressed} disabled={false} {...props} {...next}/>
  ));
  const pointer = (target: Element, type: string, button = 0) => act(() => {
    const event = new MouseEvent(type, {button, bubbles: true, cancelable: true});
    target.dispatchEvent(event);
  });
  const cleanup = () => { act(() => root.unmount()); container.remove(); };
  return {chosen, pressed, container, render, pointer, cleanup};
}

it("短按选择当前成员；长按展开且不额外切换；禁用/隐藏/卸载清理计时器", () => {
  vi.useFakeTimers();
  const {chosen, pressed, container, render, pointer, cleanup} = setup();
  try {
    render();
    pointer(container.querySelector("button")!, "pointerdown");
    act(() => vi.advanceTimersByTime(349));
    pointer(container.querySelector("button")!, "pointerup");
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(chosen.mock.calls).toEqual([[member("rectMarquee")]]);
    expect(container.querySelector("[data-group-menu]")).toBeNull();

    pointer(container.querySelector("button")!, "pointerdown");
    act(() => vi.advanceTimersByTime(350));
    expect(container.querySelector("[data-group-menu]")).not.toBeNull();
    // 长按期间选中按钮显示的成员（上游 #4453）。
    expect(pressed).toHaveBeenCalledWith(member("rectMarquee"));
    pointer(container.querySelector("button")!, "pointerup");
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    // 结束长按的那次释放/点击不再重复选择。
    expect(chosen).toHaveBeenCalledTimes(1);

    render({disabled: true});
    pointer(container.querySelector("button")!, "pointerdown");
    act(() => vi.advanceTimersByTime(400));
    expect(container.querySelector("[data-group-menu]")).toBeNull();

    render({disabled: false, hidden: true});
    pointer(container.querySelector("button")!, "pointerdown");
    act(() => vi.advanceTimersByTime(400));
    expect(container.querySelector("[data-group-menu]")).toBeNull();

    render({hidden: false});
    pointer(container.querySelector("button")!, "pointerdown");
    cleanup();
    act(() => vi.advanceTimersByTime(400));
    expect(vi.getTimerCount()).toBe(0);
  } finally { cleanup(); vi.useRealTimers(); }
});

it("按下拖出立即展开，释放在成员上直接选择；外部释放取消，重复右键关闭", () => {
  const {chosen, container, render, pointer, cleanup} = setup();
  try {
    render();
    const trigger = container.querySelector("button")!;
    pointer(trigger, "pointerdown");
    pointer(trigger, "pointerout");
    const ellipse = container.querySelector('[data-group-menu] [data-tool-member="ellipseMarquee"]')!;
    expect(ellipse).not.toBeNull();
    pointer(ellipse, "pointerup");
    expect(chosen.mock.calls).toEqual([[member("ellipseMarquee")]]);
    expect(container.querySelector("[data-group-menu]")).toBeNull();

    pointer(trigger, "pointerdown");
    pointer(trigger, "pointerout");
    pointer(document.body, "pointerup");
    expect(chosen).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-group-menu]")).toBeNull();

    pointer(trigger, "contextmenu");
    expect(container.querySelector("[data-group-menu]")).not.toBeNull();
    pointer(trigger, "contextmenu");
    expect(container.querySelector("[data-group-menu]")).toBeNull();
  } finally { cleanup(); }
});

it("flyout 列出槽位全部成员并标出当前项，选择只派发一次", () => {
  const {chosen, container, render, pointer, cleanup} = setup();
  try {
    render();
    pointer(container.querySelector("button")!, "contextmenu");
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-group-menu] button"));
    expect(rows.map(row => row.dataset.toolMember)).toEqual(["rectMarquee", "ellipseMarquee", "singleRowMarquee", "singleColumnMarquee"]);
    expect(container.querySelector('[data-group-menu] [data-tool-member="rectMarquee"]')?.getAttribute("data-selected")).toBe("true");
    act(() => container.querySelector<HTMLButtonElement>('[data-group-menu] [data-tool-member="singleRowMarquee"]')!.click());
    expect(chosen.mock.calls).toEqual([[member("singleRowMarquee")]]);
    expect(container.querySelector("[data-group-menu]")).toBeNull();
  } finally { cleanup(); }
});

it("单成员槽位不弹层、不画三角，单击仍选该成员", () => {
  const zoom = TOOL_SLOTS.find(slot => slot.index === 20)!;
  const chosen = vi.fn(), container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    const render = () => act(() => root.render(<ToolSlotButton slot={zoom} shown={zoom.members[0]!} active onChoose={chosen} disabled={false}/>));
    render();
    const trigger = container.querySelector("button")!;
    act(() => trigger.dispatchEvent(new MouseEvent("contextmenu", {bubbles: true})));
    expect(container.querySelector("[data-group-menu]")).toBeNull();
    expect(container.querySelector(".photo-editor__tool-group-mark")).toBeNull();
    act(() => trigger.click());
    expect(chosen.mock.calls).toEqual([[zoom.members[0]]]);
  } finally { act(() => root.unmount()); container.remove(); }
});

it("Escape、指针取消与显示成员变化都关闭弹层且不选择", () => {
  const {chosen, container, render, pointer, cleanup} = setup();
  try {
    render();
    pointer(container.querySelector("button")!, "contextmenu");
    expect(container.querySelector("[data-group-menu]")).not.toBeNull();
    act(() => container.querySelector("[data-group-menu]")!.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true})));
    expect(container.querySelector("[data-group-menu]")).toBeNull();

    pointer(container.querySelector("button")!, "pointerdown");
    pointer(container.querySelector("button")!, "pointercancel");
    expect(container.querySelector("[data-group-menu]")).toBeNull();

    pointer(container.querySelector("button")!, "contextmenu");
    render({shown: member("ellipseMarquee")});
    expect(container.querySelector("[data-group-menu]")).toBeNull();
    expect(chosen).not.toHaveBeenCalled();
  } finally { cleanup(); }
});
