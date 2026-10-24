/**
 * 画布上的参考线/原点拖动会话（U70）。
 *
 * ## 为什么单独一层
 *
 * 命中、拖动位置反算与提交都在内核（`viewPointer` / `guideCommand`）。画布的 `pointerdown`
 * / `pointermove` / `pointerup` 只需要「开始 → 更新 → 提交或取消」四个动作，不应该自己算
 * 坐标，也不应该在拖动过程中改文档。
 *
 * 因此这里是一个**不写文档、不造历史**的会话对象：
 *
 * - `begin` 只做命中；没命中就返回 `null`，让画布继续按当前工具处理；
 * - `update` 只产出草稿位置（界面拿去画预览线），文档不动；
 * - `commit` 才发一条 `view.moveGuide`，一步历史；值没变则不发，避免空历史；
 * - `cancel` 什么都不写，草稿丢弃即可。
 *
 * 目标文档身份随会话捕获（`viewSnapshot.document.id`），切标签后提交会被内核以
 * `view.stale` 拒绝——不会把 A 文档的参考线索引写到 B 文档上。
 */
import type { EditorResult } from "../../editor-wasm.js";
import type { GuideHitView } from "./decode.js";

/** 一次拖动会话的稳定描述（界面据此画预览、显示锁定提示）。 */
export type GuideDrag = {
  kind: "guide";
  /** 水平线为 `false`，垂直线为 `true`（与内核 `vertical` 参数一致）。 */
  vertical: boolean;
  /**
   * 这次拖动是**移动已有参考线**还是**从标尺拖出新参考线**。
   *
   * 两者共用同一条「按下 → 移动 → 松手」路径，但提交命令不同（`view.moveGuide` 带索引，
   * `view.newGuide` 不带），并且新建时没有「原位置」可比，因此不做值未变判定。
   */
  mode: "move" | "create";
  /** 被拖动参考线的索引（`create` 时为 `-1`）。 */
  index: number;
  /** 按下时的原始位置（`create` 时为 `NaN`，只用于 `move` 的比较）。 */
  from: number;
  /** 当前草稿位置；`create` 且还没移动过时为 `NaN`。 */
  position: number;
  /** 拖动开始时的文档身份；提交时回传，切文档后被内核拒绝。 */
  documentId?: number;
};

export type OriginDrag = {
  kind: "origin";
  /** 草稿原点；未移动过时为文档当前原点。 */
  origin: [number, number];
  /** 拖动开始时的文档原点（用于判断「值没变就不提交」）。 */
  from: [number, number];
  documentId?: number;
};

export type ViewDrag = GuideDrag | OriginDrag;

/** 手势依赖的端口子集：命中/反算 + 提交，均为本域已有入口。 */
export type ViewGesturePorts = {
  /** `viewPointer`：只读几何。 */
  pointer: (
    action: "hit-guide" | "drag-guide" | "drag-origin",
    client: readonly [number, number],
    extra?: { vertical?: boolean; tolerance?: number; viewId?: string },
  ) => EditorResult<
    | { kind: "hit"; locked: boolean; hit: GuideHitView | null }
    | { kind: "drag"; vertical: boolean; position: number | null; locked: boolean }
    | { kind: "origin"; origin: [number, number] | null; current: [number, number] }
  >;
  /** `guideCommand`：写文档、走历史。 */
  commit: (id: string, params: Record<string, unknown>) => EditorResult<unknown>;
  /** 会话开始时的文档身份（`viewSnapshot.document.id`，旧运行时可能没有）。 */
  documentId?: number;
  /** 视图 id：多视图下只有活动视图接收输入（内核复核）。 */
  viewId?: string;
  /** 参考线是否被锁定（从标尺拖出新线前先看这一位，避免拖了才发现被拒）。 */
  locked?: boolean;
};

/** 拖动容差（屏幕像素）；内核按 `tolerance / zoom` 换算成源像素。 */
const TOLERANCE = 6;

/** 标尺角落尺寸，与 `view-aids-overlay` 的 `RULER_CORNER` 保持一致（上边 20、左边 24）。 */
const RULER_CORNER_WIDTH = 24;
const RULER_CORNER_HEIGHT = 20;

export class ViewGestureSession {
  private active: ViewDrag | null = null;
  /** 从标尺条按下时需要接管后续 move/up 的指针 id（覆盖层拿不到画布的捕获）。 */
  private rulerPointer: number | null = null;

  constructor(private readonly ports: ViewGesturePorts) {}

  /**
   * 标尺条按下：新建草稿并记住指针 id。
   *
   * 覆盖层的标尺条在画布容器**之上**，事件不会冒泡到画布，因此这里要自己记住指针，
   * 由调用方在 window 上继续跟踪移动与抬起。
   */
  startRulerGuide(vertical: boolean, pointerId: number): GuideDrag | null {
    if (this.ports.locked) return null;
    const drag = this.beginRulerGuide(vertical);
    this.rulerPointer = drag ? pointerId : null;
    return drag;
  }

  /** 正在被标尺条拖动跟踪的指针 id；没有则为 `null`。 */
  get trackedPointer(): number | null {
    return this.rulerPointer;
  }

  /** 结束标尺条跟踪（提交或取消后调用）。 */
  releasePointer(): void {
    this.rulerPointer = null;
  }

  /** 当前会话（没有则为 `null`）；界面按它画草稿。 */
  current(): ViewDrag | null {
    return this.active;
  }

  /**
   * 在客户坐标处开始拖动参考线。
   *
   * 返回 `null` 表示「这里没有参考线」——画布应当继续按当前工具处理，而不是吞掉这次按下。
   * 参考线被锁定时返回 `{ locked: true }`，界面据此显示禁止光标且不进入拖动。
   */
  beginGuide(client: readonly [number, number]): { locked: boolean; drag: GuideDrag | null } {
    const result = this.ports.pointer("hit-guide", client, { tolerance: TOLERANCE, viewId: this.ports.viewId });
    if (!result.ok || result.value.kind !== "hit") return { locked: false, drag: null };
    const hit = result.value.hit;
    if (!hit) return { locked: false, drag: null };
    if (result.value.locked) return { locked: true, drag: null };
    this.active = {
      kind: "guide",
      vertical: hit.vertical,
      mode: "move",
      index: hit.index,
      from: hit.position,
      position: hit.position,
      documentId: this.ports.documentId,
    };
    return { locked: false, drag: this.active };
  }

  /**
   * 从标尺条按下：新建一条参考线并开始拖动。
   *
   * `vertical` 为 `true` 表示从**上边**标尺拖出的竖线，`false` 是从左边标尺拖出的横线。
   * 这时还没有索引（提交走 `view.newGuide`），拖动位置仍由内核反算，和移动已有线同一口径。
   *
   * 参考线锁定时不新建（与「锁定拦参考线增删」一致），返回 `null` 让界面显示禁止。
   */
  beginRulerGuide(vertical: boolean): GuideDrag | null {
    this.active = {
      kind: "guide",
      vertical,
      mode: "create",
      index: -1,
      from: Number.NaN,
      position: Number.NaN,
      documentId: this.ports.documentId,
    };
    return this.active;
  }

  /** 在客户坐标处开始拖动标尺原点（标尺角落按下时由画布调用）。 */
  beginOrigin(client: readonly [number, number], corner?: HTMLElement | null): OriginDrag | null {
    // 语义核对：内核的 `drag-origin` 只要坐标有限就回 `current`（当前原点值），并不判断
    // 「这一下是否真的按在标尺角落」。只看 `current` 会把画布上每一次按下都当成拖原点，
    // 画笔/选区/修饰等全部手势都会被吞掉。因此命中判定留在界面这一层：只有按在标尺角落
    // （24×20，与 `view-aids-overlay` 的角落矩形同一尺寸）才接管，其余一律交回画布。
    if (corner) {
      const box = corner.getBoundingClientRect();
      const inside =
        client[0] >= box.left && client[0] <= box.left + RULER_CORNER_WIDTH &&
        client[1] >= box.top && client[1] <= box.top + RULER_CORNER_HEIGHT;
      if (!inside) return null;
    }
    const result = this.ports.pointer("drag-origin", client, { viewId: this.ports.viewId });
    if (!result.ok || result.value.kind !== "origin" || !result.value.current) return null;
    this.active = {
      kind: "origin",
      origin: result.value.current,
      from: result.value.current,
      documentId: this.ports.documentId,
    };
    return this.active;
  }

  /**
   * 指针移动到客户坐标：只更新草稿位置。
   *
   * 越界/非法位置（`null`）保持上一个草稿值，不把参考线丢到 `NaN` 上。
   */
  update(client: readonly [number, number]): ViewDrag | null {
    const drag = this.active;
    if (!drag) return null;
    if (drag.kind === "guide") {
      const result = this.ports.pointer("drag-guide", client, { vertical: drag.vertical, viewId: this.ports.viewId });
      if (result.ok && result.value.kind === "drag" && result.value.position !== null) drag.position = result.value.position;
      return drag;
    }
    const result = this.ports.pointer("drag-origin", client, { viewId: this.ports.viewId });
    if (result.ok && result.value.kind === "origin" && result.value.origin) drag.origin = result.value.origin;
    return drag;
  }

  /**
   * 提交：参考线发 `view.moveGuide`，原点发 `view.setRulerOrigin`。
   *
   * 值没变化时不提交（返回 `{ changed: false }`），避免拖动 1px 内松手就多一步空历史。
   * 提交失败原样返回，由界面提示；此时草稿也一并丢弃，不留半拖动状态。
   */
  commit(): EditorResult<{ changed: boolean }> {
    const drag = this.active;
    this.active = null;
    if (!drag) return { ok: true, value: { changed: false } };
    const target = drag.documentId === undefined ? {} : { targetDocument: drag.documentId };
    if (drag.kind === "guide") {
      // 还没移动过（新建时 `position` 仍是 `NaN`）就什么都不提交。
      if (!Number.isFinite(drag.position)) return { ok: true, value: { changed: false } };
      if (drag.mode === "move" && drag.position === drag.from) {
        return { ok: true, value: { changed: false } };
      }
      const orientation = drag.vertical ? "vertical" : "horizontal";
      const result = drag.mode === "create"
        ? this.ports.commit("view.newGuide", { orientation, position: drag.position, ...target })
        : this.ports.commit("view.moveGuide", {
            orientation, index: drag.index, position: drag.position, ...target,
          });
      return result.ok ? { ok: true, value: { changed: true } } : result;
    }
    if (drag.origin[0] === drag.from[0] && drag.origin[1] === drag.from[1]) {
      return { ok: true, value: { changed: false } };
    }
    const result = this.ports.commit("view.setRulerOrigin", { x: drag.origin[0], y: drag.origin[1], ...target });
    return result.ok ? { ok: true, value: { changed: true } } : result;
  }

  /** 取消：丢弃草稿，不写文档、不造历史。 */
  cancel(): void {
    this.active = null;
  }

  /** 是否有进行中的拖动（画布据此决定要不要接管指针）。 */
  get dragging(): boolean {
    return this.active !== null;
  }
}

/**
 * 从工作区控制器建拖动会话。
 *
 * 端口细节（`features.views.*` 还是旧 facade、快照是否带回文档身份）收在这里，宿主只需要
 * 在画布上把按下/移动/抬起转发进来。缺任一端口时返回 `null`，画布退回原行为。
 */
export function createGuideGesture(
  controller: {
    guideCommand: (id: string, params: unknown) => EditorResult<unknown>;
    features?: { views?: Record<string, unknown> };
  },
  documentId?: number,
  viewId?: string,
  locked?: boolean,
): ViewGestureSession | null {
  const views = controller.features?.views;
  const pointer = views?.viewPointer;
  if (typeof pointer !== "function") return null;
  return new ViewGestureSession({
    pointer: pointer.bind(views) as ViewGesturePorts["pointer"],
    commit: (id, params) => controller.guideCommand(id, params),
    documentId,
    viewId,
    locked,
  });
}
