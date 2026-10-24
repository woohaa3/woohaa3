/**
 * 绘画工具的分派决策（change: refactor-photocraft-toolbar，design D2）。
 *
 * 撤下伪工具 `retouch` 后，16 个绘画/润饰工具各自是一级工具 id，但它们仍共用一条
 * 按下→整笔→释放的派发路径。这里把「这次按下该怎么处理」抽成纯函数，让每个工具 id
 * 都能在无浏览器环境下被断言，而不是只能靠读 `photo-editor-app.tsx` 的分支。
 */
import {RETOUCH_SPECS, isRetouchTool, type RetouchToolId} from "./retouch-tools.js";

export type PaintDispatch =
  /** 不属于绘画/润饰工具：交给画笔/铅笔/橡皮或其它手势。 */
  | {kind:"other"}
  /** 点按类工具（红眼、魔术橡皮擦）：按下即提交一个坐标。 */
  | {kind:"point"; tool:RetouchToolId; command:string}
  /** Alt/Option 取样来源点：不绘制。 */
  | {kind:"sample"; tool:RetouchToolId; command:string}
  /** 整笔在释放时一次提交。 */
  | {kind:"stroke"; tool:RetouchToolId; command:string}
  /** 缺少必需参数（例如图案图章没有图案）：不派发。 */
  | {kind:"blocked"; tool:RetouchToolId; command:string; reason:string};

/** 该工具按下的分派方式；`alt` 只在克隆类工具上有意义。 */
export function paintDispatch(tool:string, options:{alt?:boolean; hasPattern?:boolean} = {}):PaintDispatch {
  if (!isRetouchTool(tool)) return {kind:"other"};
  const spec = RETOUCH_SPECS[tool];
  const command = spec.command;
  if ((tool === "cloneStamp" || tool === "healingBrush") && options.alt) {
    return {kind:"sample", tool, command};
  }
  if (spec.point) return {kind:"point", tool, command};
  if (spec.needsPattern && !options.hasPattern) {
    return {kind:"blocked", tool, command, reason:"请先选择图案"};
  }
  return {kind:"stroke", tool, command};
}

/** 该工具是否需要实时笔迹预览。上游只为 History Brush 提供，本实现不伪造其它工具的预览。 */
export function paintSupportsLivePreview(tool:string):boolean {
  return isRetouchTool(tool) && tool === "historyBrush";
}
