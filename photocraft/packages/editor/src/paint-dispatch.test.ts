/**
 * 绘画工具的分派决策（change: refactor-photocraft-toolbar，任务 2.3/7.3）。
 *
 * 每个绘画/润饰工具是一级工具 id，但共用一条派发路径；这里逐个工具断言「按下该怎么处理」，
 * 证明它们没有回落到普通画笔，也不会互相串用参数。
 */
import {describe,expect,it} from "vitest";
import {paintDispatch,paintSupportsLivePreview} from "./paint-dispatch.js";
import {RETOUCH_SPECS,retouchToolIds} from "./retouch-tools.js";
import {buildRetouch,DEFAULT_RETOUCH} from "./retouch-tools.js";

const points=[{x:10,y:20},{x:12,y:22}];

describe("按下分派", () => {
  it("普通画笔/铅笔/橡皮/油漆桶不进入绘画工具分派", () => {
    for (const tool of ["brush", "pencil", "eraser", "bucket", "move", "marquee", "text", "pan"]) {
      expect(paintDispatch(tool)).toEqual({kind:"other"});
    }
  });

  it("点按类工具按下即提交一个坐标", () => {
    for (const tool of ["redEye", "magicEraser"] as const) {
      expect(paintDispatch(tool)).toEqual({kind:"point", tool, command:RETOUCH_SPECS[tool].command});
    }
  });

  it("其余工具整笔在释放时提交", () => {
    const strokeTools = retouchToolIds().filter(tool => !["redEye", "magicEraser"].includes(tool));
    expect(strokeTools).toHaveLength(14);
    for (const tool of strokeTools) {
      expect(paintDispatch(tool, {hasPattern:true})).toEqual({kind:"stroke", tool, command:RETOUCH_SPECS[tool].command});
    }
  });

  it("图案图章缺图案时不派发，并给出可操作原因", () => {
    expect(paintDispatch("patternStamp", {hasPattern:false}))
      .toEqual({kind:"blocked", tool:"patternStamp", command:"paint.patternStamp", reason:"请先选择图案"});
    expect(paintDispatch("patternStamp", {hasPattern:true}).kind).toBe("stroke");
  });

  it("克隆类工具的 Alt 取样不绘制，且只对克隆与修复生效", () => {
    for (const tool of ["cloneStamp", "healingBrush"] as const) {
      expect(paintDispatch(tool, {alt:true})).toEqual({kind:"sample", tool, command:RETOUCH_SPECS[tool].command});
    }
    // 其它工具按 Alt 不改变分派方式。
    for (const tool of ["brush", "dodge", "blur", "redEye", "mixer"] as const) {
      expect(paintDispatch(tool, {alt:true}).kind).not.toBe("sample");
    }
  });

  it("16 个工具全部有分派结论，没有落回 other", () => {
    for (const tool of retouchToolIds()) {
      expect(paintDispatch(tool, {hasPattern:true}).kind).not.toBe("other");
    }
  });

  it("只有 History Brush 声明实时预览", () => {
    for (const tool of retouchToolIds()) {
      expect(paintSupportsLivePreview(tool)).toBe(tool === "historyBrush");
    }
    expect(paintSupportsLivePreview("brush")).toBe(false);
  });
});

describe("跨工具参数隔离", () => {
  it("每个工具只编译自己的命令参数，不串用其它工具字段", () => {
    // 同一组设置喂给不同工具：命令不同，且输出字段与该工具的参数编译器一致。
    const settings = {...DEFAULT_RETOUCH, size:33, opacity:44, toneRange:"shadows" as const, strength:12, wet:70, tolerance:9};
    const seen = new Map<string, string>();
    for (const tool of retouchToolIds()) {
      const params = buildRetouch(tool, points[0]!, points, {...settings, pattern:"dots"}, "#123456", "pixels", 1);
      expect(params).not.toBeNull();
      const command = RETOUCH_SPECS[tool].command;
      // 一个命令不会被两个工具共用。
      expect(seen.has(command)).toBe(false);
      seen.set(command, tool);
    }
    expect(seen.size).toBe(16);
  });

  it("色调工具传范围与曝光，模糊族传强度，混合画笔传湿/载/混，互不污染", () => {
    const tone = buildRetouch("dodge", points[0]!, points, DEFAULT_RETOUCH, "#000000", "pixels", 1)!;
    expect(tone).toHaveProperty("range");
    expect(tone).not.toHaveProperty("strength");
    expect(tone).not.toHaveProperty("wet");

    const blur = buildRetouch("blur", points[0]!, points, DEFAULT_RETOUCH, "#000000", "pixels", 1)!;
    expect(blur).toHaveProperty("strength");
    expect(blur).not.toHaveProperty("range");
    expect(blur).not.toHaveProperty("wet");

    const mixer = buildRetouch("mixer", points[0]!, points, DEFAULT_RETOUCH, "#000000", "pixels", 1)!;
    expect(mixer).toHaveProperty("wet");
    expect(mixer).not.toHaveProperty("range");
    expect(mixer).not.toHaveProperty("strength");

    const colorReplacement = buildRetouch("colorReplacement", points[0]!, points, DEFAULT_RETOUCH, "#000000", "pixels", 1)!;
    expect(colorReplacement).toHaveProperty("sampling");
    expect(colorReplacement).not.toHaveProperty("wet");
  });

  it("橡皮槽三个工具各自编译不同的擦除参数", () => {
    const eraser = buildRetouch("backgroundEraser", points[0]!, points, DEFAULT_RETOUCH, "#000000", "pixels", 1)!;
    expect(eraser).toHaveProperty("sampling");
    const magic = buildRetouch("magicEraser", points[0]!, points, DEFAULT_RETOUCH, "#000000", "pixels", 1)!;
    expect(magic).toHaveProperty("x");
    expect(magic).not.toHaveProperty("sampling");
    // 普通橡皮不经过这个编译器（走 buildStroke）。
    expect(paintDispatch("eraser").kind).toBe("other");
  });
});
