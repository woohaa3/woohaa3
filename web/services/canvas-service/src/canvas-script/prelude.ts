/**
 * Canvas Script 受限执行：注入 prelude
 * （change: 2026-10-13-add-canvas-script-authoring，任务 2.1–2.4 / design D2、D4）。
 *
 * 这段源码在 QuickJS 独立 realm 内、**用户脚本之前**求值：它做两件事。
 *
 * 1. **隔离加固**：删除宿主访问、时间/随机、动态代码入口与异步任务能力。特别地，
 *    `Function.prototype.constructor` 必须在删除 `globalThis.Function` **之前**置空，
 *    否则 `(function(){}).constructor(...)` 仍可动态编译代码（实测行为，见 notes/verification）。
 * 2. **recorder**：注入冻结的 `canvas` API。所有调用只把语义操作压入有序数组，绝不触碰
 *    宿主、画布或 IO；handle 由闭包内 `WeakSet` 验证，脚本无法伪造。
 *
 * 结构校验（未知字段、非法 kind、非有限坐标、重复 key）在**记录时**判定并写入
 * `__S.fatal`，脚本即使 catch 掉异常也无法绕过。宿主只读取
 * `JSON.stringify({ops, fatal, apiCalls})`，因此跨边界只有严格 JSON，无宿主函数或原型。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 5.1 / 6.1：这里原本按展开操作数
 * （256）、API 调用次数（4096）与 prompt 字符数（8000）拒绝。这些应用侧总量额度已删除：
 * 完整合法计划正常记录并由同一 planner 校验后一次原子提交；`apiCalls` 只作为观察量保留。
 * 保留的字段长度上限只覆盖标识符与展示标题（真实表达/可读性约束），不限制作品内容总量。
 */

/** prelude 需要的运行时事实（全部来自 contracts 的单一事实源）。 */
export type CanvasScriptPreludeOptions = {
  /** 支持的语义节点种类（拒绝未知 kind 且给出定位）。 */
  nodeKinds: readonly string[];
  /** 节点位置坐标绝对值上限（画布世界坐标的真实表达边界）。 */
  positionAbsMax: number;
  /** 标识符/展示标题的单字段长度上限（真实表达约束，不是执行额度）。 */
  textMaxChars: number;
};

const strings = (values: readonly string[]): string => JSON.stringify(values);

/**
 * 构造 prelude 源码。
 *
 * 纯字符串拼接，无任何宿主值注入；数字/字符串常量由调用方按事实源填入。
 */
export function canvasScriptPrelude(options: CanvasScriptPreludeOptions): string {
  return `
"use strict";
(function () {
  var ALLOWED_KINDS = ${strings(options.nodeKinds)};
  var TEXT_MAX = ${options.textMaxChars};
  var POS_ABS_MAX = ${options.positionAbsMax};

  // ---- 私有状态（闭包内，脚本不可见） ----------------------------------
  var S = {
    refs: new Map(),
    handles: new WeakSet(),
    nodes: new Set(),
    deleted: new Set(),
    ops: [],
    auto: 0,
    apiCalls: 0,
    fatal: null
  };

  function fatal(code, message, api, field, operationIndex) {
    if (S.fatal) return;
    S.fatal = { code: code, message: message, api: api || undefined, field: field || undefined, operationIndex: operationIndex };
  }

  function reject(code, message, api, field) {
    fatal(code, message, api, field, S.ops.length);
    throw new TypeError(message);
  }

  function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  // 严格字段检查：未知字段直接拒绝（nodeData/canonical type 等一律不放过）。
  function checkKeys(value, label, api, allowed) {
    if (!plain(value)) reject("malformed-request", label + " 必须是对象", api, label);
    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (allowed.indexOf(key) < 0) reject("malformed-request", label + " 不接受字段 " + key, api, label + "." + key);
    }
  }

  function text(value, label, api, field, max) {
    if (value === undefined) return undefined;
    if (typeof value !== "string") reject("malformed-request", label + " 必须是字符串", api, field);
    if (value.length > max) reject("script-limit-exceeded", label + " 超过 " + max + " 字符上限", api, field);
    return value;
  }

  function position(value, api, field) {
    checkKeys(value, "position", api, ["x", "y"]);
    if (typeof value.x !== "number" || typeof value.y !== "number" || !isFinite(value.x) || !isFinite(value.y)) {
      reject("malformed-request", "position 必须是有限数值 { x, y }", api, field);
    }
    if (Math.abs(value.x) > POS_ABS_MAX || Math.abs(value.y) > POS_ABS_MAX) {
      reject("script-limit-exceeded", "position 超出画布坐标上限", api, field);
    }
    return { x: value.x, y: value.y };
  }

  function allocRef(key, api) {
    var ref;
    if (key === undefined) {
      ref = "__auto-" + S.auto;
      S.auto += 1;
    } else {
      if (typeof key !== "string" || key.length === 0) reject("malformed-request", "key 必须是非空字符串", api, "key");
      if (key.length > TEXT_MAX) reject("script-limit-exceeded", "key 超过长度上限", api, "key");
      ref = key;
    }
    if (S.refs.has(ref)) reject("duplicate-ref", "key " + ref + " 重复（节点与边共享命名空间）", api, "key");
    return ref;
  }

  function isNode(value) {
    return plain(value) && S.handles.has(value) && value.__kind === "node";
  }

  function isEdge(value) {
    return plain(value) && S.handles.has(value) && value.__kind === "edge";
  }

  function entity(handle) {
    return handle.__ref !== undefined ? { ref: handle.__ref } : { nodeId: handle.__nodeId };
  }

  function asNode(handle, api, field) {
    if (isEdge(handle)) reject("invalid-ref", api + " 需要节点 handle，但收到边 handle", api, field);
    if (!isNode(handle)) reject("invalid-ref", api + " 需要本次执行返回的节点 handle", api, field);
    if (handle.__ref !== undefined && S.deleted.has(handle.__ref)) {
      reject("unknown-ref", "节点 " + handle.__ref + " 已在同一计划中删除", api, field);
    }
    return handle;
  }

  function makeNodeHandle(ref) {
    var handle = Object.freeze({ __kind: "node", __ref: ref });
    S.handles.add(handle);
    return handle;
  }

  function makeExistingHandle(nodeId) {
    if (typeof nodeId !== "string" || nodeId.length === 0) reject("malformed-request", "existing(nodeId) 需要非空字符串", "existing", "nodeId");
    if (nodeId.length > TEXT_MAX) reject("script-limit-exceeded", "nodeId 超过长度上限", "existing", "nodeId");
    var handle = Object.freeze({ __kind: "node", __nodeId: nodeId });
    S.handles.add(handle);
    return handle;
  }

  function placement(value, api) {
    if (value === undefined) return undefined;
    if (!plain(value)) reject("malformed-request", "placement 必须是对象", api, "placement");
    var mode = value.mode;
    if (mode === "absolute") {
      checkKeys(value, "placement", api, ["mode", "position"]);
      if (!plain(value.position)) reject("malformed-request", "absolute placement 需要 position", api, "placement.position");
      return { mode: "absolute", position: position(value.position, api, "placement.position") };
    }
    if (mode === "auto") {
      checkKeys(value, "placement", api, ["mode"]);
      return { mode: "auto" };
    }
    if (mode === "after" || mode === "before" || mode === "below") {
      checkKeys(value, "placement", api, ["mode", "anchor", "gap"]);
      var anchor = asNode(value.anchor, api, "placement.anchor");
      var out = { mode: mode, anchor: entity(anchor) };
      if (value.gap !== undefined) {
        if (typeof value.gap !== "number" || !isFinite(value.gap) || value.gap < 0) {
          reject("malformed-request", "placement.gap 必须是非负有限数", api, "placement.gap");
        }
        out.gap = value.gap;
      }
      return out;
    }
    return reject("unsupported-placement", "未知 placement.mode " + String(mode), api, "placement.mode");
  }

  function nodeList(value, api, field) {
    var list = Array.isArray(value) ? value : [value];
    if (!list.length) reject("malformed-request", field + " 需要至少一个节点", api, field);
    return list.map(function (n) { return entity(asNode(n, api, field)); });
  }
  function requiredTitle(value, api) {
    var result = text(value, "title", api, "title", 200);
    if (result === undefined || !result.trim()) reject("malformed-request", "需要非空 title", api, "title");
    return result;
  }
  function grid(value, api) {
    checkKeys(value, "layout", api, ["mode", "columns", "gapX", "gapY", "origin"]);
    if (value.mode !== "grid" || typeof value.columns !== "number" || value.columns !== Math.floor(value.columns) || value.columns < 1) reject("malformed-request", "layout 需要 mode=grid 和正整数 columns", api, "layout");
    var result = { mode: "grid", columns: value.columns };
    for (var key of ["gapX", "gapY"]) if (value[key] !== undefined) {
      if (typeof value[key] !== "number" || !isFinite(value[key]) || value[key] < 0 || value[key] > POS_ABS_MAX) reject("malformed-request", "gap 必须是有界非负有限数", api, key);
      result[key] = value[key];
    }
    if (value.origin !== undefined) result.origin = position(value.origin, api, "layout.origin");
    return result;
  }

  function precondition(value, api) {
    if (value === undefined) return undefined;
    if (!plain(value)) reject("malformed-request", "if 必须是对象", api, "if");
    var type = value.type;
    if (type === "node-exists" || type === "node-missing" || type === "not-processing") {
      checkKeys(value, "if", api, ["type", "nodeId"]);
      if (typeof value.nodeId !== "string" || value.nodeId.length === 0) reject("malformed-request", "if.nodeId 必须是非空字符串", api, "if.nodeId");
      return { type: type, nodeId: value.nodeId };
    }
    if (type === "prompt-equals") {
      checkKeys(value, "if", api, ["type", "nodeId", "equals"]);
      if (typeof value.nodeId !== "string" || value.nodeId.length === 0) reject("malformed-request", "if.nodeId 必须是非空字符串", api, "if.nodeId");
      if (typeof value.equals !== "string") reject("malformed-request", "if.equals 必须是字符串", api, "if.equals");
      return { type: type, nodeId: value.nodeId, equals: value.equals };
    }
    return reject("malformed-request", "未知 if.type " + String(type), api, "if.type");
  }

  function beginCall(api) {
    // apiCalls 只是观察量（诊断/证据），不是可耗尽额度。
    S.apiCalls += 1;
    if (S.fatal) throw new TypeError("脚本已因 " + S.fatal.code + " 失败");
  }

  function record(op, api) {
    if (S.fatal) throw new TypeError("脚本已因 " + S.fatal.code + " 失败");
    S.ops.push(op);
  }

  var canvas = Object.freeze({
    node: function (kind, options) {
      beginCall("node");
      if (typeof kind !== "string" || ALLOWED_KINDS.indexOf(kind) < 0) reject("unsupported-node-kind", "不支持的节点种类 " + String(kind), "node", "kind");
      options = options === undefined ? {} : options;
      checkKeys(options, "node options", "node", ["key", "title", "prompt", "placement"]);
      var ref = allocRef(options.key, "node");
      var op = { op: "create_node", ref: ref, kind: kind };
      var title = text(options.title, "title", "node", "title", 200);
      if (title !== undefined) op.title = title;
      var prompt = options.prompt;
      if (prompt !== undefined) {
        if (typeof prompt !== "string") reject("malformed-request", "prompt 必须是字符串", "node", "prompt");
        op.prompt = prompt;
      }
      var place = placement(options.placement, "node");
      if (place !== undefined) op.placement = place;
      S.refs.set(ref, "node");
      S.nodes.add(ref);
      record(op, "node");
      return makeNodeHandle(ref);
    },
    existing: function (nodeId) {
      beginCall("existing");
      return makeExistingHandle(nodeId);
    },
    connect: function (from, to, options) {
      beginCall("connect");
      options = options === undefined ? {} : options;
      checkKeys(options, "connect options", "connect", ["key", "label", "if"]);
      var source = asNode(from, "connect", "from");
      var target = asNode(to, "connect", "to");
      if (entity(source).nodeId !== undefined && entity(target).nodeId !== undefined && entity(source).nodeId === entity(target).nodeId) {
        reject("invalid-connection", "不能连接节点到自身", "connect", "to");
      }
      var ref = allocRef(options.key, "connect");
      var op = { op: "connect", ref: ref, from: entity(source), to: entity(target) };
      var label = text(options.label, "label", "connect", "label", TEXT_MAX);
      if (label !== undefined) op.label = label;
      var condition = precondition(options.if, "connect");
      if (condition !== undefined) op.if = condition;
      S.refs.set(ref, "edge");
      record(op, "connect");
      var handle = Object.freeze({ __kind: "edge", __ref: ref });
      S.handles.add(handle);
      return handle;
    },
    move: function (node, target, options) {
      beginCall("move");
      options = options === undefined ? {} : options;
      checkKeys(options, "move options", "move", ["if"]);
      var handle = asNode(node, "move", "node");
      var op = { op: "move_node", target: entity(handle), position: position(target, "move", "position"), coordinateSpace: "world" };
      var condition = precondition(options.if, "move");
      if (condition !== undefined) op.if = condition;
      record(op, "move");
    },
    setPrompt: function (node, prompt, options) {
      beginCall("setPrompt");
      options = options === undefined ? {} : options;
      checkKeys(options, "setPrompt options", "setPrompt", ["if"]);
      var handle = asNode(node, "setPrompt", "node");
      var value = prompt;
      if (value === undefined) reject("malformed-request", "setPrompt 需要 prompt 字符串", "setPrompt", "prompt");
      if (typeof value !== "string") reject("malformed-request", "setPrompt 需要 prompt 字符串", "setPrompt", "prompt");
      var op = { op: "set_prompt", target: entity(handle), prompt: value };
      var condition = precondition(options.if, "setPrompt");
      if (condition !== undefined) op.if = condition;
      record(op, "setPrompt");
    },
    group: function (members, options) {
      beginCall("group");
      checkKeys(options, "group options", "group", ["key", "title", "layout", "placement", "if"]);
      var ref = allocRef(options.key, "group");
      var op = { op: "create_group", ref: ref, title: requiredTitle(options.title, "group"), members: nodeList(members, "group", "members") };
      if (options.layout !== undefined) op.layout = grid(options.layout, "group");
      if (options.placement !== undefined) op.placement = placement(options.placement, "group");
      var condition = precondition(options.if, "group"); if (condition !== undefined) op.if = condition;
      S.refs.set(ref, "node"); S.nodes.add(ref); record(op, "group");
      return makeNodeHandle(ref);
    },
    reparent: function (targets, parent, options) {
      beginCall("reparent"); options = options === undefined ? {} : options;
      checkKeys(options, "reparent options", "reparent", ["if"]);
      var op = { op: "reparent", targets: nodeList(targets, "reparent", "targets"), parent: parent === null ? null : entity(asNode(parent, "reparent", "parent")) };
      var condition = precondition(options.if, "reparent"); if (condition !== undefined) op.if = condition;
      record(op, "reparent");
    },
    ungroup: function (target, options) {
      beginCall("ungroup"); options = options === undefined ? {} : options;
      checkKeys(options, "ungroup options", "ungroup", ["if"]);
      var handle = asNode(target, "ungroup", "target");
      var op = { op: "ungroup", target: entity(handle) };
      var condition = precondition(options.if, "ungroup"); if (condition !== undefined) op.if = condition;
      record(op, "ungroup");
      if (handle.__ref !== undefined) S.deleted.add(handle.__ref);
    },
    setTitle: function (target, title, options) {
      beginCall("setTitle"); options = options === undefined ? {} : options;
      checkKeys(options, "setTitle options", "setTitle", ["if"]);
      var op = { op: "set_title", target: entity(asNode(target, "setTitle", "target")), title: requiredTitle(title, "setTitle") };
      var condition = precondition(options.if, "setTitle"); if (condition !== undefined) op.if = condition;
      record(op, "setTitle");
    },
    layout: function (targets, layout, options) {
      beginCall("layout"); options = options === undefined ? {} : options;
      checkKeys(options, "layout options", "layout", ["if"]);
      var op = { op: "layout", targets: nodeList(targets, "layout", "targets"), layout: grid(layout, "layout") };
      var condition = precondition(options.if, "layout"); if (condition !== undefined) op.if = condition;
      record(op, "layout");
    },
    remove: function (nodeOrNodes, options) {
      beginCall("remove");
      options = options === undefined ? {} : options;
      checkKeys(options, "remove options", "remove", ["if"]);
      var list = Array.isArray(nodeOrNodes) ? nodeOrNodes : [nodeOrNodes];
      if (list.length === 0) reject("malformed-request", "remove 需要至少一个节点", "remove", "nodeOrNodes");
      var targets = [];
      for (var i = 0; i < list.length; i += 1) targets.push(entity(asNode(list[i], "remove", "nodeOrNodes[" + i + "]")));
      var op = { op: "delete", targets: targets };
      var condition = precondition(options.if, "remove");
      if (condition !== undefined) op.if = condition;
      record(op, "remove");
      for (var j = 0; j < targets.length; j += 1) {
        if (targets[j].ref !== undefined) S.deleted.add(targets[j].ref);
      }
    }
  });

  Object.defineProperty(globalThis, "canvas", { value: canvas, writable: false, configurable: false, enumerable: false });

  // ---- 隔离加固 ---------------------------------------------------------
  // 先断掉函数构造器链，再删除全局 Function/eval（顺序不可颠倒）。
  try { Object.defineProperty(Function.prototype, "constructor", { value: undefined, writable: false, configurable: false }); } catch (e) {}
  var DROP = ["eval", "Function", "AsyncFunction", "GeneratorFunction", "AsyncGeneratorFunction", "WebAssembly", "Date", "Promise", "Proxy", "Reflect", "SharedArrayBuffer", "Atomics", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "requestAnimationFrame", "process", "require", "module", "exports", "global", "Buffer", "Intl"];
  for (var d = 0; d < DROP.length; d += 1) {
    try { delete globalThis[DROP[d]]; } catch (e) {}
  }
  try { delete Math.random; } catch (e) {}
  try { delete Math.imul; } catch (e) {} // 无随机用途，但避免被当作熵源组合；保留其余纯计算

  globalThis.__woohaaCanvasScriptState = {
    read: function () {
      return JSON.stringify({ ops: S.ops, fatal: S.fatal, apiCalls: S.apiCalls });
    }
  };
})();
`;
}

/** prelude 之后读取执行结果的下标表达式（宿主只读严格 JSON）。 */
export const CANVAS_SCRIPT_READ_EXPRESSION = "globalThis.__woohaaCanvasScriptState.read()";
