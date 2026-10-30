// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ParameterField } from "./parameter-field.js";
import type { ExecutionPanelParameterField } from "./types.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function ratioField(
  values: readonly string[],
  labels: Readonly<Record<string, string>> = {},
  extra: Partial<ExecutionPanelParameterField> = {}
): ExecutionPanelParameterField {
  return {
    key: "aspectRatio",
    label: "比例",
    type: "select",
    options: values.map((value) => ({ value, label: labels[value] ?? value })),
    ...extra
  };
}

function selectField(
  options: ReadonlyArray<{ value: string; label: string }>,
  extra: Partial<ExecutionPanelParameterField> = {}
): ExecutionPanelParameterField {
  return {
    key: "resolution",
    label: "分辨率",
    type: "select",
    options,
    ...extra
  };
}

function setup(
  field: ExecutionPanelParameterField,
  initialValue: string,
  extra: { lockedBy?: string } = {}
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const changes: unknown[] = [];
  function Fixture() {
    const [value, setValue] = useState(initialValue);
    return (
      <ParameterField
        field={field}
        value={value}
        {...(extra.lockedBy !== undefined ? { lockedBy: extra.lockedBy } : {})}
        onChange={(next) => {
          changes.push(next);
          setValue(String(next));
        }}
      />
    );
  }
  return {
    container,
    changes,
    async render() {
      await act(async () => root.render(<Fixture />));
    },
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    }
  };
}

function tileLabels(scope: ParentNode): Array<string | null> {
  return [...scope.querySelectorAll<HTMLButtonElement>(".mc-panel__ratio-options button")]
    .map((button) => button.getAttribute("aria-label"));
}

describe("画幅比例选择器", () => {
  it("有自适应选项时渲染取景框按钮，选中态与回传值使用目录原值", async () => {
    const view = setup(
      ratioField(["auto", "1:1", "3:4", "4:3", "9:16", "16:9", "21:9"], { auto: "自适应" }),
      "1:1"
    );
    try {
      await view.render();
      const adaptive = view.container.querySelector<HTMLButtonElement>(".mc-panel__ratio-adaptive");
      expect(adaptive).not.toBeNull();
      expect(adaptive!.textContent).toContain("自适应");
      expect(adaptive!.querySelector("svg")).not.toBeNull();
      expect(adaptive!.getAttribute("data-state")).toBe("off");
      expect(
        view.container.querySelector('.mc-panel__ratio-options [aria-label="1:1"]')?.getAttribute("data-state")
      ).toBe("on");

      await act(async () => {
        adaptive!.focus();
        adaptive!.click();
      });
      expect(view.changes).toEqual(["auto"]);
      expect(adaptive!.getAttribute("data-state")).toBe("on");
      expect(
        view.container.querySelector('.mc-panel__ratio-options button[data-state="on"]')
      ).toBeNull();
      expect(document.activeElement).toBe(adaptive);
    } finally {
      await view.cleanup();
    }
  });

  it("常用比例按 1:1、3:4、4:3、9:16、16:9 排列，其余收进更多比例", async () => {
    const view = setup(
      ratioField(["auto", "1:1", "3:4", "4:3", "9:16", "16:9", "3:2", "21:9"], { auto: "自适应" }),
      "1:1"
    );
    try {
      await view.render();
      const grid = view.container.querySelector(".mc-panel__ratio-options")!;
      expect(tileLabels(grid)).toEqual(["1:1", "3:4", "4:3", "9:16", "16:9"]);
      // 4 列网格中第 5 个（16:9）自然落到第二行。
      expect(grid.querySelectorAll("button")).toHaveLength(5);

      const more = view.container.querySelector("details")!;
      expect(more.querySelector("summary")!.textContent).toContain("更多比例（2）");
      expect(tileLabels(more)).toEqual(["3:2", "21:9"]);
    } finally {
      await view.cleanup();
    }
  });

  it("选中的非常用比例替换最后一个常用位，切换后焦点回到选中项", async () => {
    const view = setup(
      ratioField(["auto", "1:1", "3:4", "4:3", "9:16", "16:9", "21:9"], { auto: "自适应" }),
      "21:9"
    );
    try {
      await view.render();
      const grid = view.container.querySelector(".mc-panel__ratio-options")!;
      expect(tileLabels(grid)).toEqual(["1:1", "3:4", "4:3", "9:16", "21:9"]);
      expect(grid.querySelector('[aria-label="21:9"]')?.getAttribute("data-state")).toBe("on");

      const more = view.container.querySelector("details")!;
      expect(tileLabels(more)).toEqual(["16:9"]);
      more.open = true;

      await act(async () => {
        const option = more.querySelector<HTMLButtonElement>('[aria-label="16:9"]')!;
        option.focus();
        option.click();
      });
      expect(view.changes).toEqual(["16:9"]);
      expect(tileLabels(view.container.querySelector(".mc-panel__ratio-options")!)).toEqual([
        "1:1", "3:4", "4:3", "9:16", "16:9"
      ]);
      expect(
        view.container.querySelector('.mc-panel__ratio-options [aria-label="16:9"]')?.getAttribute("data-state")
      ).toBe("on");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("16:9");
    } finally {
      await view.cleanup();
    }
  });

  it("没有自适应选项时退化为纯 4 列网格并保留更多比例", async () => {
    const view = setup(
      ratioField(["1:1", "4:3", "16:9", "9:16", "21:9", "3:4"]),
      "1:1"
    );
    try {
      await view.render();
      expect(view.container.querySelector(".mc-panel__ratio-adaptive")).toBeNull();
      const layout = view.container.querySelector(".mc-panel__ratio-layout")!;
      expect(layout.classList.contains("mc-panel__ratio-layout--grid-only")).toBe(true);

      const grid = view.container.querySelector(".mc-panel__ratio-options")!;
      expect(tileLabels(grid)).toEqual(["1:1", "3:4", "4:3", "9:16", "16:9"]);
      const more = view.container.querySelector("details")!;
      expect(tileLabels(more)).toEqual(["21:9"]);

      await act(async () => {
        const option = grid.querySelector<HTMLButtonElement>('[aria-label="3:4"]')!;
        option.focus();
        option.click();
      });
      expect(view.changes).toEqual(["3:4"]);
      expect(
        grid.querySelector('[aria-label="3:4"]')?.getAttribute("data-state")
      ).toBe("on");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("3:4");
    } finally {
      await view.cleanup();
    }
  });

  it("provider 用原始 adaptive 作为 label 时仍显示自适应", async () => {
    const view = setup(
      ratioField(["adaptive", "1:1", "16:9"], { adaptive: "adaptive" }),
      "adaptive"
    );
    try {
      await view.render();
      const adaptive = view.container.querySelector<HTMLButtonElement>(".mc-panel__ratio-adaptive")!;
      expect(adaptive.textContent).toContain("自适应");
      expect(adaptive.getAttribute("aria-label")).toBe("自适应");
      expect(adaptive.getAttribute("data-state")).toBe("on");
    } finally {
      await view.cleanup();
    }
  });

  it("未声明 semantic 的旧目录仍按枚举形态走比例启发式", async () => {
    // catalog 还没有 `x-pptask-control` 时，靠「全为比例 + auto/adaptive」维持参考布局。
    const field = ratioField(["auto", "1:1", "16:9"], { auto: "自适应" });
    expect(field.semantic).toBeUndefined();
    const view = setup(field, "auto");
    try {
      await view.render();
      expect(view.container.querySelector(".mc-panel__ratio-layout")).not.toBeNull();
      expect(view.container.querySelector(".mc-panel__resolution-options")).toBeNull();
      expect(
        view.container.querySelector(".mc-panel__ratio-adaptive")?.getAttribute("data-state")
      ).toBe("on");
    } finally {
      await view.cleanup();
    }
  });
});

describe("参数语义（x-pptask-control）", () => {
  it("semantic=resolution 用等宽分段渲染并回传档位", async () => {
    const view = setup(
      selectField(
        [
          { value: "1K", label: "1K" },
          { value: "2K", label: "2K" }
        ],
        { semantic: "resolution" }
      ),
      "1K"
    );
    try {
      await view.render();
      const group = view.container.querySelector(".mc-panel__resolution-options")!;
      expect(group).not.toBeNull();
      // 保留分段控件既有 class 钩子，同时追加分辨率布局钩子。
      expect(group.classList.contains("mc-panel__settings-row")).toBe(true);
      expect(view.container.querySelector(".mc-panel__ratio-options")).toBeNull();
      const radios = group.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      expect([...radios].map((radio) => radio.getAttribute("aria-label"))).toEqual(["1K", "2K"]);
      expect(radios[0]!.getAttribute("aria-checked")).toBe("true");

      await act(async () => radios[1]!.click());
      expect(view.changes).toEqual(["2K"]);
      expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    } finally {
      await view.cleanup();
    }
  });

  it("semantic=quality 维持普通分段，不套分辨率布局", async () => {
    const view = setup(
      selectField(
        [
          { value: "standard", label: "标准" },
          { value: "hd", label: "高清" }
        ],
        { key: "quality", label: "质量", semantic: "quality" }
      ),
      "standard"
    );
    try {
      await view.render();
      expect(view.container.querySelector(".mc-panel__resolution-options")).toBeNull();
      expect(view.container.querySelector(".mc-panel__ratio-options")).toBeNull();
      const radios = view.container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      expect(radios).toHaveLength(2);
      await act(async () => radios[1]!.click());
      expect(view.changes).toEqual(["hd"]);
    } finally {
      await view.cleanup();
    }
  });

  it("semantic=aspect-ratio + adaptiveValue 选中自适应按钮并回传该值", async () => {
    const view = setup(
      ratioField(
        ["adaptive", "1:1", "16:9"],
        { adaptive: "自适应" },
        { semantic: "aspect-ratio", adaptiveValue: "adaptive" }
      ),
      "adaptive"
    );
    try {
      await view.render();
      const adaptive = view.container.querySelector<HTMLButtonElement>(".mc-panel__ratio-adaptive")!;
      expect(adaptive).not.toBeNull();
      expect(adaptive.textContent).toContain("自适应");
      expect(adaptive.getAttribute("data-state")).toBe("on");
      expect(view.container.querySelector('.mc-panel__ratio-options button[data-state="on"]')).toBeNull();

      await act(async () => {
        const tile = view.container.querySelector<HTMLButtonElement>(
          '.mc-panel__ratio-options [aria-label="16:9"]'
        )!;
        tile.focus();
        tile.click();
      });
      expect(view.changes).toEqual(["16:9"]);
      expect(adaptive.getAttribute("data-state")).toBe("off");
      expect(
        view.container.querySelector('.mc-panel__ratio-options [aria-label="16:9"]')?.getAttribute("data-state")
      ).toBe("on");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("16:9");

      await act(async () => adaptive.click());
      expect(view.changes).toEqual(["16:9", "adaptive"]);
      expect(adaptive.getAttribute("data-state")).toBe("on");
    } finally {
      await view.cleanup();
    }
  });

  it("semantic=aspect-ratio 即使枚举很短也走比例布局（不依赖数量启发式）", async () => {
    const view = setup(
      ratioField(
        ["fit", "1:1", "16:9"],
        { fit: "自适应" },
        { semantic: "aspect-ratio", adaptiveValue: "fit" }
      ),
      "fit"
    );
    try {
      await view.render();
      // `fit` 不是 auto/adaptive，启发式不会命中；语义声明仍然选中自适应按钮。
      const adaptive = view.container.querySelector<HTMLButtonElement>(".mc-panel__ratio-adaptive")!;
      expect(adaptive).not.toBeNull();
      expect(adaptive.getAttribute("data-state")).toBe("on");
      expect(tileLabels(view.container.querySelector(".mc-panel__ratio-options")!)).toEqual(["1:1", "16:9"]);
    } finally {
      await view.cleanup();
    }
  });
});
describe("音色选择器", () => {
  it("semantic=voice 渲染成下拉：显示人读名称，回传上游音色 id", async () => {
    const field = selectField(
      [
        { value: "male-qn-qingse", label: "青涩青年音色（中文）" },
        { value: "English_expressive_narrator", label: "Expressive Narrator（英文）" }
      ],
      { key: "voice", label: "音色", semantic: "voice", defaultValue: "male-qn-qingse" }
    );
    const view = setup(field, "male-qn-qingse");
    try {
      await view.render();
      const select = view.container.querySelector<HTMLSelectElement>(".mc-panel__settings-select");
      expect(select).not.toBeNull();
      expect([...select!.options].map((option) => option.textContent)).toContain(
        "Expressive Narrator（英文）"
      );
      expect(select!.value).toBe("male-qn-qingse");

      await act(async () => {
        select!.value = "English_expressive_narrator";
        select!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(view.changes.at(-1)).toBe("English_expressive_narrator");
    } finally {
      await view.cleanup();
    }
  });
});

describe("联动锁定", () => {
  const formatField: ExecutionPanelParameterField = {
    key: "outputFormat",
    label: "输出格式",
    type: "select",
    options: [
      { value: "png", label: "PNG" },
      { value: "jpeg", label: "JPEG" }
    ]
  };

  it("没有 lockedBy 时可以正常点选", async () => {
    const view = setup(formatField, "png");
    try {
      await view.render();
      const option = view.container.querySelector<HTMLButtonElement>(".ui-segmented__option")!;
      expect(option.disabled).toBe(false);
      expect(view.container.querySelector(".mc-panel__settings-lock")).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it("被别的字段锁定时：组内按钮全部禁用，标签说明锁定者", async () => {
    const view = setup(formatField, "png", { lockedBy: "背景" });
    try {
      await view.render();
      const buttons = [...view.container.querySelectorAll<HTMLButtonElement>(".ui-segmented__option")];
      expect(buttons.length).toBeGreaterThan(0);
      // 锁定态下连当前值也不可点：改了会被联动覆盖，允许点只会产生抖动。
      expect(buttons.every((button) => button.disabled)).toBe(true);
      expect(view.container.querySelector(".mc-panel__settings-lock")?.textContent).toBe("由「背景」决定");
      expect(view.container.querySelector("[data-locked-by]")).not.toBeNull();
    } finally {
      await view.cleanup();
    }
  });
});
