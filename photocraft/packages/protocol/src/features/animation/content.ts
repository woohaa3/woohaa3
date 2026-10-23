/**
 * 时间轴内容身份（U77，design D1）。
 *
 * 帧模型、帧率与时长属于**工程内容**；播放头/工作区范围是会话视图。本文件是 TS 侧对这套
 * 规则的规范化描述，供宿主在保存前声明「这份文档确实带时间轴/视频帧」，并与 Rust
 * `features/animation/content.rs` 的字段集保持一致（字段名相同、顺序相同）。
 *
 * 条目用**图层树位置 + 图层名**标识，不使用图层 id：加载工程时 id 会重新分配，把 id 写进身份
 * 会让同一份工程在每次重开后被判成已修改。
 *
 * 不重复声明预算：帧数/像素上限由内核 `timelineJson().budget` 报告。
 */

export type AnimationContentFrame = {
  /** 稀疏像素摘要（内核 `surface_hash`），同一内容重开后稳定。 */
  contentHash: string;
  width: number;
  height: number;
  format: string;
};

/** 规范化的边界：与内核 `features::animation::limits` 及 `project-limits.json` 的图层上限同值。 */
const ANIMATION_MAX_FRAMES = 120;
const ANIMATION_MAX_LAYERS = 64;

export type AnimationContentTimeline = { fps: number; duration: number };

export type AnimationContentVideo = {
  fps: number;
  showAltered: boolean;
  frames: AnimationContentFrame[];
  original?: AnimationContentFrame[];
};

/**
 * 图层树中的一个条目：用图层名定位（图层 id 在加载时会重新分配，不能进身份）。
 *
 * `video` 为 `null` 表示这个图层自己**没有**帧栈（例如只有子层带帧的组）；`children` 只在该
 * 图层子树里确实有视频层时出现。二者不能互相顶替，否则「组只有子层帧」与「组有一组空帧栈」
 * 会得到同一份内容身份。
 */
export type AnimationContentLayer = {
  name: string;
  video: AnimationContentVideo | null;
  children?: AnimationContentLayer[];
};
/** 整份文档的动画内容贡献；`null` 表示没有时间轴也没有视频层（旧工程身份不变）。 */
export type AnimationContent = {
  timeline: AnimationContentTimeline | null;
  layers: AnimationContentLayer[];
};

/** 一个文档是否携带动画内容（宿主据此决定是否向内容身份追加本域字段）。 */
export function hasAnimationContent(value: AnimationContent | null | undefined): value is AnimationContent {
  if (!value) return false;
  return value.timeline !== null || value.layers.length > 0;
}

/**
 * 内容摘要的规范序列：字段顺序固定，`original`/`children` 只在存在时出现。
 *
 * 这是**纯函数**，只做规范化（不读文档、不算像素）；调用方提供内核摘要。
 */
export function animationContentKey(value: AnimationContent): string {
  const frames = (list: AnimationContentFrame[]) => list.map(frame => [frame.contentHash, frame.width, frame.height, frame.format]);
  const layer = (entry: AnimationContentLayer): unknown => {
    const video = entry.video === null
      ? null
      : (() => {
          const out: Record<string, unknown> = {
            fps: entry.video.fps,
            showAltered: entry.video.showAltered,
            frames: frames(entry.video.frames)
          };
          if (entry.video.original) out.original = frames(entry.video.original);
          return out;
        })();
    return entry.children === undefined ? [entry.name, video] : [entry.name, video, entry.children.map(layer)];
  };
  return JSON.stringify([
    value.timeline ? [value.timeline.fps, value.timeline.duration] : null,
    value.layers.map(layer)
  ]);
}

/**
 * 动画贡献的**规范文本**：与 Rust `identity::canonicalize_animation` 逐字节一致。
 *
 * 与 [`animationContentKey`] 的分工：那个是域内摘要（JSON，便于阅读与排查），这个是进入
 * `canonicalizeImageProjectContent` 的跨语言规范行——宿主与内核必须对「是否净变化」得到同一
 * 指纹，所以格式必须两端逐字节相同。用长度前缀而不是 JSON，避免嵌套转义让文本随深度膨胀，
 * 也避免图层名里的分隔符造成歧义。
 *
 * 非法结构返回 `null`（调用方必须当作「无法判定」，绝不当作「无变化」）。
 */
export function canonicalizeAnimationContent(value: AnimationContent): string | null {
  const timeline = value.timeline === null
    ? "-"
    : (() => {
        const fps = jsRounded(value.timeline.fps);
        const duration = value.timeline.duration;
        if (fps === null || !Number.isInteger(duration) || duration < 1) return null;
        return `${fps},${duration}`;
      })();
  if (timeline === null) return null;
  if (!Array.isArray(value.layers) || value.layers.length > ANIMATION_MAX_LAYERS) return null;
  let entries = "[";
  for (const layer of value.layers) {
    const text = canonicalizeAnimationLayer(layer);
    if (text === null) return null;
    entries += text;
  }
  entries += "]";
  return `animation:${timeline}:${utf16Length(entries)}:${entries}`;
}

function canonicalizeAnimationLayer(entry: AnimationContentLayer): string | null {
  if (typeof entry.name !== "string" || entry.name.length > 200) return null;
  const video = entry.video === null ? "-" : canonicalizeAnimationVideo(entry.video);
  if (video === null) return null;
  let body = `${utf16Length(entry.name)}:${entry.name}@${video}`;
  if (entry.children !== undefined) {
    if (!Array.isArray(entry.children) || entry.children.length > ANIMATION_MAX_LAYERS) return null;
    let nested = "[";
    for (const child of entry.children) {
      const text = canonicalizeAnimationLayer(child);
      if (text === null) return null;
      nested += text;
    }
    nested += "]";
    body += `#${utf16Length(nested)}:${nested}`;
  }
  return `${utf16Length(body)}:${body}`;
}

function canonicalizeAnimationVideo(video: AnimationContentVideo): string | null {
  const fps = jsRounded(video.fps);
  if (fps === null || typeof video.showAltered !== "boolean") return null;
  const frames = canonicalizeAnimationFrames(video.frames);
  if (frames === null) return null;
  let out = `${fps},${video.showAltered ? 1 : 0},${frames}`;
  if (video.original !== undefined) {
    const original = canonicalizeAnimationFrames(video.original);
    if (original === null) return null;
    out += `;${original}`;
  }
  return out;
}

function canonicalizeAnimationFrames(frames: AnimationContentFrame[]): string | null {
  if (!Array.isArray(frames) || frames.length > ANIMATION_MAX_FRAMES) return null;
  let out = "[";
  for (const frame of frames) {
    if (typeof frame.contentHash !== "string" || !/^[0-9a-f]{16}$/.test(frame.contentHash)) return null;
    if (!Number.isInteger(frame.width) || frame.width < 0 || !Number.isInteger(frame.height) || frame.height < 0) return null;
    if (typeof frame.format !== "string" || frame.format.length === 0 || frame.format.length > 32) return null;
    if (/[,;:[\]@#]/.test(frame.format)) return null;
    out += `${frame.contentHash},${frame.width},${frame.height},${frame.format};`;
  }
  out += "]";
  return `${utf16Length(out)}:${out}`;
}

/** UTF-16 code unit 数（与 Rust `identity::utf16_len` 和 JS `String.length` 一致）。 */
function utf16Length(text: string): number {
  return text.length;
}

/**
 * `String(Math.round(value * 1e4) / 1e4)`——与 Rust `identity::js_rounded` 同一规则。
 *
 * 非有限值返回 `null`（调用方按「无法判定」处理）。
 */
function jsRounded(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 1e4) / 1e4;
  if (!Number.isFinite(rounded)) return null;
  return String(rounded === 0 ? 0 : rounded);
}
