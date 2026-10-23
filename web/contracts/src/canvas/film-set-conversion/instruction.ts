/**
 * 内置转换指令与结构化片场候选 schema
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.3 / design D2/D5）。
 *
 * 生成器（ChatGPT / 语言 Provider）共用同一份**按来源种类派生**的指令文本与结构化候选 schema，
 * 保证「图片/视频转换」在不同 adapter 上产出一致、可被 `validateFilmSetConversionCandidate`
 * 完整校验的 items-only 候选。纯字符串/JSON 构造，无副作用、不接触 provider SDK。
 */
import {
  FILM_SET_CONTENT_VERSION,
  MAX_FILM_SET_NAME_LENGTH,
  establishItemMotionAdapter,
  type FilmSetItem
} from "../film-set-content.js";
import { FILM_SET_ANIMATIONS_VERSION } from "../film-set-animations.js";
import { PREFERRED_MODEL_SCRIPT_VERSION, MODEL_SCRIPT_LANGUAGE } from "../model-script.js";
import { MODEL_API_AXIS_CONVENTIONS, modelApiGuide, modelPrimitiveConstraintsText, modelRenderBudgetText } from "../model-api-descriptor.js";
import { motionApiGuide } from "../model-api-descriptor-motion.js";
import { deriveModelContentVersion, type ModelPlacement } from "../model-definition.js";
import { MOTION_SCRIPT_LANGUAGE, MOTION_SCRIPT_VERSION, hashMotionScript } from "../motion-script.js";
import type { FilmSetConversionRange, FilmSetConversionRepair, FilmSetConversionSourceKind } from "./types.js";
import { FILM_SET_CONVERSION_INSTRUCTION_VERSION } from "./types.js";

/** 创建弹窗与生成器共用的默认场景要求；脚本 API 与结构约束仍由生成器附加。 */
export function defaultFilmSetConversionPrompt(sourceKind: FilmSetConversionSourceKind): string {
  if (sourceKind === "video") return "根据视频内容创建可编辑的 3D 片场，尽量还原主体、比例、空间布局和构图，将主要对象分别建模。\n\n还原视频中的主要运镜与人物、对象动作；存在多个镜头时以主要场景为基准，不将冲突场景混在一起。无法还原的动作或省略内容请明确说明。";
  if (sourceKind === "image") return "根据图片内容创建可编辑的 3D 片场，尽量还原主体、比例、空间布局和构图，将主要对象分别建模。\n\n保持原图的视角与取景，使用简洁、可编辑的几何表达细节，不因简化而遗漏主要内容。";
  return "";
}

export type FilmSetConversionInstructionInput = {
  /** 来源种类（image / video）。 */
  sourceKind: FilmSetConversionSourceKind;
  /** 目标片场标题（作为默认名称）。 */
  title: string;
  /** 用户可选补充要求（长度已由请求层限制）。 */
  instruction?: string;
  /** 本次视频处理范围（秒）；缺省表示整个视频。 */
  range?: FilmSetConversionRange;
  /** 视频真实时长（秒）；缺省未知。 */
  durationSeconds?: number;
  /** 本次输入给模型的实际图像帧时间戳（服务端抽帧时提供；原生视频输入时缺省）。 */
  frameTimestamps?: readonly number[];
  /** 是否以原生视频输入（否则为帧组）。 */
  nativeVideo: boolean;
  /**
   * 允许候选媒体项引用的稳定资产 id 集合（源资产等）。
   *
   * 模型 MUST 只用这些 id 引用媒体；任何其它 id 或外部 URL 会被完整校验拒绝。
   */
  assetIds?: readonly string[];
  /**
   * 上一次候选被完整校验拒绝时的修复指引（可选）。
   *
   * 提供时指令会附上上一份候选与校验错误，要求模型**只修复该问题**并返回完整候选；缺省为首次生成。
   */
  repair?: FilmSetConversionRepair;
};

/**
 * 构造按来源派生的内置转换指令。
 *
 * 指令明确：只输出结构化候选；不得发明外部 URL；媒体引用必须使用输入中给定的稳定资产 id；
 * 视频省略的内容必须显式说明；items-only 片场契约（无顶层 authored 模型）。
 */
export function buildFilmSetConversionInstruction(input: FilmSetConversionInstructionInput): string {
  // 模型脚本 API 指南直接取自 descriptor（与执行器/ MCP 指南同一事实来源），避免「只给 API 名字、
  // 不给调用形式」导致模型写出引用未定义全局 `SceneBuilder` 的脚本被校验拒绝。
  const modelApi = modelApiGuide();
  const modelApiMethods = modelApi.methods.map((method) => `- ${method.signature}`).join("\n");
  // 动作脚本 API 同样取自 descriptor：转换指令此前只要求写 `cameraMotionScript`/`bindings[].motion`，却
  // 没给 `motion.*` 的调用形式，模型只能留空 → 交付静态片场（「人物完全不动」）。
  const motionApi = motionApiGuide();
  const motionApiMethods = motionApi.methods.map((method) => `- ${method.signature}`).join("\n");
  const motionConventions = Object.entries(motionApi.conventions).map(([name, value]) => `${name}: ${value}`).join("; ");
  const lines: string[] = [
    "You convert ONE media source into an editable film-set (items-only) definition.",
    "Return ONLY a JSON object matching the required schema. Do not use tools, run commands, read files, or access the network.",
    `Target film-set title: ${input.title}.`,
    `Source kind: ${input.sourceKind}.`
  ];
  if (input.sourceKind === "video") {
    const range = input.range
      ? `${input.range.startSeconds}s–${input.range.endSeconds}s`
      : "the whole video";
    lines.push(
      `Processed video range: ${range}${input.durationSeconds ? ` (of ${input.durationSeconds}s total)` : ""}.`,
      input.nativeVideo
        ? "The actual video content is attached as native video input; read its real content."
        : `The video is provided as a real frame set with timestamps: ${
            (input.frameTimestamps ?? []).map((t) => `${t.toFixed(3)}s`).join(", ") || "(none)"
          }.`,
      "Rebuild the visible scene as editable model objects (subjects, proportions, relative layout), as faithfully as the source allows; do NOT drop visible content to simplify.",
      "The video has motion: you MUST reproduce it. Put camera movement (pan/tilt/zoom/dolly/roll) into the clip's `cameraMotionScript` and object/character motion into `bindings[].motion` (a coarse approximation is acceptable and expected). Use the frame timestamps above to infer the motion.",
      "Do NOT deliver a static clip unless the source is genuinely static (no camera move AND no subject move). If you fall back to static, you MUST set `note` to state which camera/object motion was not reproduced, e.g. 「已生成场景，部分动作未还原」.",
      "Do not force conflicting shots into one scene; state the adopted range and omissions in `note`.",
      `Motion API (angles in ${motionApi.conventions.angleUnit}, time in ${motionApi.conventions.timeUnit}; a binding whose target is the whole object uses the id \"root\"):\n${motionApiMethods}`,
      `Motion conventions: ${motionConventions}`,
      "Put `motion.camera.*` calls in the clip's `cameraMotionScript` and `motion.model.*` calls in each binding's `motion.motionScript`; they are separate scripts. Keep every track within the clip duration (startTime/endTime in seconds).",
      `Motion API reference example (camera + object shown together for brevity; split them as above and adapt times/values to the source):\n${motionApi.example}`,
      `Film-set item motion example (binding target "root" = the whole item):\n${motionApi.parkourExample}`,
      // 只保留与「输出整个候选 JSON」适用的规则：把 MCP 工具/已有场景语义的规则排除，避免在禁工具的转换回合里误导模型去调用工具。
      ...motionApi.authoringRules
        .filter((rule) => !rule.includes("mutate_film_set_item") && !rule.includes("保留已有场景"))
        .map((rule) => `Motion rule: ${rule}`),
      "Motion rule: 只把动作写进片段 `cameraMotionScript` / `bindings[].motion.motionScript`，不要调用任何工具或改写与动作无关的内容。"
    );
  } else {
    lines.push(
      "The actual image content is attached as a real image; read its real pixels.",
      "Rebuild the visible scene as editable model objects: reproduce the main subject(s), their proportions, relative positions and the overall composition as faithfully as the source allows.",
      "Express geometry as simple, editable primitives instead of dense meshes, but do NOT drop visible content or subjects just to simplify.",
      "Set `sceneCamera` to reproduce the source viewpoint and framing (choose azimuth/elevation/distance/focusOffset so the rendered composition matches the photo); omit it only when the image gives no usable viewpoint cue."
    );
  }
  lines.push(
    `Output an items-only film-set: filmSetContent.schemaVersion MUST be ${FILM_SET_CONTENT_VERSION}, items only (no top-level authored model).`,
    "The film-set MUST contain at least one item with kind \"model\" that reconstructs the visible content as an editable 3D model. A single flat copy of the source (image/video items only) is NOT an acceptable result.",
    "Each item needs a stable unique id, a name (<= " + MAX_FILM_SET_NAME_LENGTH + " chars), a legal localTransform {offset:{x,y,z},scale,yaw}, and a kind.",
    "Model items carry a complete, deterministic, self-contained modelScript; language \"" + "javascript" + "\".",
    `modelScriptVersion MUST be "${PREFERRED_MODEL_SCRIPT_VERSION}". Write modelScript as the BODY of a function whose ONLY injected builder is the parameter named \`scene\` (see the reference example).`,
    "There is NO global named `SceneBuilder`: scripts MUST call `scene.box(...)`, `scene.cylinder(...)`, `scene.sphere(...)`, `scene.capsule(...)`, `scene.segment(...)`, `scene.mesh(...)`, `scene.group(...)` and `scene.material(...)`. Referencing an undefined global fails validation.",
    "`scene` and `rangeNum` are injected function parameters: do NOT declare or assign a top-level `scene`/`rangeNum` (a top-level `const scene = ...` fails to compile with \"Identifier 'scene' has already been declared\"). Either call `scene.*` directly at the top level, or define `function build(scene) { ... }`.",
    `Model API (units: up ${MODEL_API_AXIS_CONVENTIONS.up}, front ${MODEL_API_AXIS_CONVENTIONS.front}, left ${MODEL_API_AXIS_CONVENTIONS.left}; rotation in ${MODEL_API_AXIS_CONVENTIONS.rotationUnit}; positions in ${MODEL_API_AXIS_CONVENTIONS.positionSpace}):\n${modelApiMethods}`,
    `Model script reference example (must compile and run exactly in this form):\n${modelApi.example}`,
    modelRenderBudgetText(),
    modelPrimitiveConstraintsText(),
    "Model scripts must not read other nodes and must not declare animations (no rotate/move/oscillate).",
    "Only reference media assets by the exact stable assetId provided to you; NEVER invent external URLs or new assets.",
    ...(input.assetIds && input.assetIds.length > 0
      ? [`Allowed media assetId values: ${input.assetIds.join(", ")}.`]
      : ["Do not reference any media asset unless it was explicitly provided."]),
    `filmSetAnimations.schemaVersion MUST be ${FILM_SET_ANIMATIONS_VERSION}; each shot MUST set "kind" to "static" or "dynamic". A static shot MUST have duration 0, loop false, an empty cameraMotionScript, and no object motion or timed media playback. A dynamic shot MUST have a positive duration (seconds) and carries the camera/object motion; a fixed camera filming a moving subject is still "dynamic". Do NOT infer kind from whether cameraMotionScript is empty; many shots are dynamic with an empty camera script. cameraMotionScript is required (empty string = still camera); object motion lives in bindings[].motion referencing existing item ids.`,
    "Camera fields (`sceneCamera` and each clip's `camera`): `azimuth` and `elevation` are in RADIANS (NOT degrees); elevation 0 = level, +1.5708 ≈ straight up, and MUST stay within ±1.5708; `distance` is a positive world distance; `focusOffset` is a world-space offset from the scene bounding-box center (aim it at the subject, e.g. chest height).",
    "sceneCamera should reproduce the source framing/composition whenever usable viewpoint cues exist; omit it only when they do not.",
    "`filmSetContent` items are in world units with a life-like scale: build the subject at its real size (a standing person is about 1.7–2.7 units tall). Include a `ground` item ONLY when the source shows a visible floor; if you include one, keep its `size` close to the subject footprint (about 8×8). A giant plane such as 200×200 is WRONG — it shrinks the subject to almost nothing in the node preview and inflates the selection scope; omit the ground entirely when no floor is visible."
  );
  const prompt = input.instruction?.trim() || defaultFilmSetConversionPrompt(input.sourceKind);
  if (prompt) lines.push(`Scene instruction: ${prompt}`);
  if (input.repair) {
    lines.push(
      "Your PREVIOUS candidate was REJECTED by full validation. Fix ONLY the reported problem and return a complete, corrected candidate; keep every other object, id, name, clip, camera and the overall reconstruction unchanged.",
      `Validation error: ${input.repair.message}`,
      `Previous candidate JSON (for reference only):\n${safeJson(input.repair.candidate)}`
    );
  }
  return lines.join("\n");
}

/** 回喂上一份候选时安全序列化（循环/不可序列化时退回占位说明，不中断生成）。 */
function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 0);
    return typeof text === "string" ? text : "(unavailable)";
  } catch {
    return "(unavailable)";
  }
}

/**
 * 结构化候选 schema（OpenAI 严格结构化输出兼容：所有 properties 都在 required，additionalProperties:false，
 * 可选字段用 `["type","null"]` 表达）。
 *
 * 刻意保持有限深度：模型产出候选对象，完整领域校验由 `validateFilmSetConversionCandidate` 负责，
 * schema 只保证形状可解析（不在此重复领域规则）。
 */
export function filmSetConversionCandidateSchema(): Record<string, unknown> {
  const transform = {
    type: "object",
    properties: {
      offset: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        required: ["x", "y", "z"],
        additionalProperties: false
      },
      scale: { type: "number" },
      yaw: { type: "number" }
    },
    required: ["offset", "scale", "yaw"],
    additionalProperties: false
  };

  const modelItem = {
    type: "object",
    properties: {
      id: { type: "string" },
      kind: { type: "string", enum: ["model"] },
      name: { type: "string" },
      localTransform: transform,
      modelScript: { type: "string", description: "完整、自包含、确定性的静态模型脚本函数体；唯一注入的构建器参数名为 scene（无全局 SceneBuilder）" },
      modelScriptVersion: { type: ["string", "null"], description: `作者 API 版本；不确定填 null（缺省 ${PREFERRED_MODEL_SCRIPT_VERSION}）` }
    },
    required: ["id", "kind", "name", "localTransform", "modelScript", "modelScriptVersion"],
    additionalProperties: false
  };

  const mediaItem = {
    type: "object",
    properties: {
      id: { type: "string" },
      kind: { type: "string", enum: ["image", "video"] },
      name: { type: "string" },
      localTransform: transform,
      assetId: { type: "string", description: "必须使用输入中给定的稳定资产 id，不得发明外部 URL" },
      aspectRatio: { type: "number" }
    },
    required: ["id", "kind", "name", "localTransform", "assetId", "aspectRatio"],
    additionalProperties: false
  };

  const groundItem = {
    type: "object",
    properties: {
      id: { type: "string" },
      kind: { type: "string", enum: ["ground"] },
      name: { type: "string" },
      localTransform: transform,
      size: {
        type: "object",
        properties: { width: { type: "number" }, depth: { type: "number" } },
        required: ["width", "depth"],
        additionalProperties: false
      },
      color: { type: ["string", "null"] }
    },
    required: ["id", "kind", "name", "localTransform", "size", "color"],
    additionalProperties: false
  };

  const camera = {
    type: ["object", "null"],
    properties: {
      azimuth: { type: "number" },
      elevation: { type: "number" },
      distance: { type: "number" },
      aspect: { type: "string" },
      focusOffset: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        required: ["x", "y", "z"],
        additionalProperties: false
      }
    },
    required: ["azimuth", "elevation", "distance", "aspect", "focusOffset"],
    additionalProperties: false
  };

  const binding = {
    type: "object",
    properties: {
      itemId: { type: "string" },
      motionScript: { type: ["string", "null"], description: "对象动作脚本；静态填 null" },
      duration: { type: "number" },
      loop: { type: "boolean" }
    },
    required: ["itemId", "motionScript", "duration", "loop"],
    additionalProperties: false
  };

  const clip = {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      kind: { type: "string", enum: ["static", "dynamic"], description: "拍摄镜头类型：static 零时长静态取景；dynamic 正时长可播放镜头（固定机位拍运动对象也是 dynamic）" },
      duration: { type: "number" },
      loop: { type: "boolean" },
      cameraMotionScript: { type: "string", description: "拍摄镜头运动脚本；静态镜头填空字符串" },
      camera: camera,
      bindings: { type: ["array", "null"], items: binding }
    },
    required: ["id", "name", "kind", "duration", "loop", "cameraMotionScript", "camera", "bindings"],
    additionalProperties: false
  };

  return {
    type: "object",
    properties: {
      items: { type: "array", items: { anyOf: [modelItem, mediaItem, groundItem] } },
      clips: { type: ["array", "null"], items: clip },
      defaultClipId: { type: ["string", "null"] },
      sceneCamera: camera,
      note: { type: ["string", "null"] }
    },
    required: ["items", "clips", "defaultClipId", "sceneCamera", "note"],
    additionalProperties: false
  };
}

/** 指令版本（写在候选来源 metadata；结构变化时提升）。 */
export const FILM_SET_CONVERSION_PROMPT_VERSION = FILM_SET_CONVERSION_INSTRUCTION_VERSION;

/**
 * 把结构化输出的扁平淡候选归一为 `FilmSetConversionCandidate`（供服务端完整校验）。
 *
 * 模型的扁形状（items + clips + sceneCamera + note）在此组装为领域候选：
 * `filmSetContent`、`filmSetAnimations`（含 cameraMotion）。**不**在此做领域校验；非法结构由
 * `validateFilmSetConversionCandidate` 拒绝。
 */
export function normalizeFilmSetConversionOutput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const raw = input as Record<string, unknown>;
  const items: unknown[] = Array.isArray(raw.items) ? raw.items.map(normalizeItem) : [];
  const itemsById = new Map<string, FilmSetItem>();
  for (const item of items) {
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const typed = item as FilmSetItem;
      if (typeof typed.id === "string" && typed.id !== "") itemsById.set(typed.id, typed);
    }
  }
  const clipsRaw: unknown[] = Array.isArray(raw.clips) ? raw.clips : [];
  const clips = clipsRaw.map((clip, index) => normalizeClip(clip, index, itemsById));
  const firstClipId = clips.find((clip) => typeof (clip as { id?: unknown }).id === "string") as { id?: string } | undefined;
  const animations = clips.length > 0
    ? {
        schemaVersion: FILM_SET_ANIMATIONS_VERSION,
        defaultClipId: typeof raw.defaultClipId === "string" && raw.defaultClipId ? raw.defaultClipId : firstClipId?.id ?? null,
        clips
      }
    : { schemaVersion: FILM_SET_ANIMATIONS_VERSION, defaultClipId: null, clips: [] };
  return {
    filmSetContent: { schemaVersion: FILM_SET_CONTENT_VERSION, items },
    filmSetAnimations: animations,
    ...(raw.sceneCamera !== undefined && raw.sceneCamera !== null ? { sceneCamera: raw.sceneCamera } : {}),
    ...(typeof raw.note === "string" && raw.note.trim() ? { note: raw.note.trim() } : {})
  };
}

function normalizeItem(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const raw = input as Record<string, unknown>;
  const localTransform = raw.localTransform ?? raw.transform ?? raw.placement;
  if (raw.kind === "model") {
    const modelScript = typeof raw.modelScript === "string" ? raw.modelScript : "";
    const modelScriptVersion = typeof raw.modelScriptVersion === "string" && raw.modelScriptVersion
      ? raw.modelScriptVersion
      : PREFERRED_MODEL_SCRIPT_VERSION;
    // 内容标识必须由实际源码/摆放派生（客户端声明的 hash 不被信任），否则完整校验会拒绝。
    const contentVersion = deriveModelContentVersion({
      modelScript,
      modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
      modelScriptVersion,
      placement: readModelPlacement(localTransform),
      revision: 1
    });
    return {
      id: raw.id,
      kind: "model",
      name: raw.name,
      localTransform,
      model: {
        modelScript,
        modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
        modelScriptVersion,
        contentVersion,
        placement: readModelPlacement(localTransform)
      }
    };
  }
  if (raw.kind === "image" || raw.kind === "video") {
    return {
      id: raw.id,
      kind: raw.kind,
      name: raw.name,
      localTransform,
      assetId: raw.assetId,
      aspectRatio: typeof raw.aspectRatio === "number" && Number.isFinite(raw.aspectRatio) && raw.aspectRatio > 0 ? raw.aspectRatio : 1
    };
  }
  return { id: raw.id, kind: "ground", name: raw.name, localTransform, size: raw.size, ...(typeof raw.color === "string" ? { color: raw.color } : {}) };
}

/** 读取摆放（非法形状退回单位变换，交给完整校验拒绝）。 */
function readModelPlacement(input: unknown): ModelPlacement {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };
  const raw = input as Record<string, unknown>;
  const offset = typeof raw.offset === "object" && raw.offset !== null
    ? (raw.offset as Record<string, unknown>)
    : {};
  const x = typeof offset.x === "number" ? offset.x : 0;
  const y = typeof offset.y === "number" ? offset.y : 0;
  const z = typeof offset.z === "number" ? offset.z : 0;
  return {
    offset: { x, y, z },
    scale: typeof raw.scale === "number" && raw.scale > 0 ? raw.scale : 1,
    yaw: typeof raw.yaw === "number" ? raw.yaw : 0
  };
}

function normalizeClip(input: unknown, index: number, itemsById: ReadonlyMap<string, FilmSetItem>): unknown {
  const raw = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const rawDuration = typeof raw.duration === "number" && Number.isFinite(raw.duration) && raw.duration >= 0 ? raw.duration : 0;
  const rawCameraMotionScript = typeof raw.cameraMotionScript === "string" ? raw.cameraMotionScript : "";
  const declaredKind = raw.kind === "static" || raw.kind === "dynamic" ? raw.kind : null;
  // kind 显式；缺失时按内容推断（正时长/有动作 → dynamic）。静态不受 duration>0 暗中延长。
  const kind: "static" | "dynamic" = declaredKind ?? (rawDuration > 0 || rawCameraMotionScript.trim() ? "dynamic" : "static");
  const duration = kind === "static" ? 0 : (rawDuration > 0 ? rawDuration : 0);
  const loop = kind === "static" ? false : (typeof raw.loop === "boolean" ? raw.loop : false);
  const cameraMotionScript = kind === "static" ? "" : rawCameraMotionScript;
  const bindingsRaw = Array.isArray(raw.bindings) ? raw.bindings : [];
  const bindings = bindingsRaw.flatMap((binding) => {
    if (typeof binding !== "object" || binding === null || Array.isArray(binding)) return [];
    const b = binding as Record<string, unknown>;
    if (typeof b.itemId !== "string" || b.itemId === "") return [];
    const script = typeof b.motionScript === "string" ? b.motionScript.trim() : "";
    const bDurationRaw = typeof b.duration === "number" && Number.isFinite(b.duration) && b.duration >= 0 ? b.duration : 0;
    const bDuration = kind === "static" ? 0 : bDurationRaw;
    const item = itemsById.get(b.itemId);
    // 静态镜头不得携带对象动作或正时长时序；这里按 kind 收敛，交给完整校验复核。
    const effectiveScript = kind === "static" ? "" : script;
    return [{
      itemId: b.itemId,
      playback: { startTime: 0, duration: bDuration, timeScale: 1, loop: kind === "dynamic" && typeof b.loop === "boolean" ? b.loop : false },
      ...(effectiveScript
        ? { motion: createMotionDefinition(effectiveScript, item) }
        : {})
    }];
  });
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `clip-${index + 1}`,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `拍摄镜头 ${index + 1}`,
    kind,
    timeline: { duration, loop },
    initialCamera: raw.camera ?? defaultCamera(),
    cameraMotion: createMotionDefinition(cameraMotionScript, undefined),
    bindings
  };
}

/**
 * 组装完整 `MotionDefinition`。
 *
 * `sourceHash` 由实际源码派生；`basedOnModelVersion` 必须指向绑定对象的适配内容 hash
 * （模型/媒体/地面各自算法见 `establishItemMotionAdapter`），否则下游片场 codec 会因
 * 「motionSourceHash 非法」拒绝整份候选。绑定对象缺失时退回镜头语义的占位关联。
 */
function createMotionDefinition(motionScript: string, item: FilmSetItem | undefined): Record<string, unknown> {
  return {
    motionScript,
    motionScriptLanguage: MOTION_SCRIPT_LANGUAGE,
    motionScriptVersion: MOTION_SCRIPT_VERSION,
    revision: 1,
    sourceHash: hashMotionScript(motionScript),
    basedOnModelVersion: adapterAssociation(item)
  };
}

function adapterAssociation(item: FilmSetItem | undefined): { revision: number; contentHash: string } {
  if (item) {
    try {
      return establishItemMotionAdapter(item);
    } catch {
      // 非法对象形状：交给完整领域校验拒绝，这里只保证结构可解析。
    }
  }
  return { revision: 1, contentHash: "camera" };
}

function defaultCamera(): Record<string, unknown> {
  return { azimuth: 0, elevation: Math.PI / 4, distance: 4, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } };
}
