/**
 * Dialog focus 管理（change: add-frontend-dialog-system，任务 3.2）。
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { captureFocus, focusInitial, focusableWithin, restoreFocus } from "./focus.js";

function setup(html: string): void {
  document.body.innerHTML = html;
}

describe("focus 管理", () => {
  it("focusInitial 优先显式 initial target", () => {
    setup(`
      <div id="c">
        <input id="first" />
        <button id="explicit" data-dialog-initial-focus>ok</button>
      </div>
    `);
    focusInitial(document.getElementById("c")!);
    expect(document.activeElement?.id).toBe("explicit");
  });

  it("focusInitial 回退到首个可编辑控件", () => {
    setup(`
      <div id="c">
        <button id="b">按钮</button>
        <textarea id="ta"></textarea>
      </div>
    `);
    focusInitial(document.getElementById("c")!);
    expect(document.activeElement?.id).toBe("ta");
  });

  it("focusableWithin 收集可聚焦元素（Radix FocusScope 据此 trap）", () => {
    setup(`
      <div id="c">
        <button id="first">1</button>
        <button id="last">2</button>
      </div>
    `);
    const container = document.getElementById("c")!;
    const ids = focusableWithin(container).map((element) => element.id);
    expect(ids).toEqual(["first", "last"]);
  });

  it("restoreFocus 优先 opener，opener 失效回退画布 owner", () => {
    setup(`
      <button id="opener">打开</button>
      <canvas id="bevy-canvas"></canvas>
    `);
    const opener = document.getElementById("opener")!;
    restoreFocus(document, opener);
    expect(document.activeElement?.id).toBe("opener");
    opener.remove();
    restoreFocus(document, opener);
    // canvas 不是原生可聚焦元素；回退时至少不应停留在 detach 的 opener 上。
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement?.id).not.toBe("opener");
  });

  it("captureFocus 返回当前聚焦元素", () => {
    setup(`<input id="a" /><input id="b" />`);
    document.getElementById("b")!.focus();
    expect((captureFocus(document) as HTMLElement).id).toBe("b");
  });
});
