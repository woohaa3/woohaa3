/**
 * Skill 媒体步骤续接 downstream client 契约
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 4.1–4.4）。
 *
 * MCP Service 不拥有步骤 ledger，也不直接读 SQLite：这里只声明宿主（backend）注入的
 * 受控查询面。等待与查询都不隐式提交生成；超时/取消等待不影响媒体任务。
 */
import type {
  SkillMediaStepView,
  SkillStepEventPage,
  SkillStepOutputView,
  SkillStepWaitView
} from "@woohaa3/contracts";

export type SkillStepClientInput = {
  /** 组作用域校验与 HTTP 路由共用；省略时由宿主按当前 scope 推导。 */
  canvasId: string;
  skillRunId: string;
  stepId: string;
  /** 供组作用域做节点归属校验；不是身份的一部分。 */
  nodeId?: string;
};

export type SkillStepClientResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type SkillStepClient = {
  /** 有界等待；followLatest 时自动跟随替代关系。 */
  wait(input: SkillStepClientInput & { waitMs: number; followLatest?: boolean }): Promise<SkillStepClientResult<SkillStepWaitView>>;
  /** 最新成功输出；allowFallback 只在当前尝试失败/取消时返回显式旧版本。 */
  latestOutput(input: SkillStepClientInput & { allowFallback?: boolean }): Promise<SkillStepClientResult<SkillStepOutputView>>;
  /** 断线恢复：按步骤身份读取权威快照（不重发 Provider 请求）。 */
  snapshot(input: SkillStepClientInput): Promise<SkillStepClientResult<SkillMediaStepView>>;
  /** 断线恢复：按游标重放步骤事件；resetRequired 时调用方必须重读快照。 */
  events(input: SkillStepClientInput & { after?: number; limit?: number }): Promise<SkillStepClientResult<SkillStepEventPage>>;
};
