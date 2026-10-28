/**
 * `ctx.diagnostics`：宿主诊断缓冲的**只读**视图。
 *
 * 服务契约在这里定义，宿主实现采集与投影。与 `ctx.log` 的分工：`log` 是**写**出口，本服务是
 * **读**出口。读取只返回已脱敏的投影，扩展拿不到原始日志行，也拿不到宿主内部状态。
 */

/**
 * 本机宿主诊断日志的一条记录（已脱敏、有界）。
 *
 * 只由宿主写入：`category` 是模块标识，`event` 是稳定事件名，`message` 是短说明，
 * `attributes` 是有界的键值细节。不含令牌、请求体、响应正文、媒体字节或任意资源名。
 * 浏览器只读，不能伪造或清空。
 */
export type ApplicationBackendDiagnosticEntry = {
  /**
   * 条目自身的稳定标识（UUID v4），**记录那一刻生成、此后不再变**。
   *
   * 它是上报的幂等键：同一条目被重复上报（扩展重载、重试、并发点击、多批重发）时，
   * 服务端按「主体 + id」只落一条。`seq` 只是进程内的读取游标——它随进程重建归零，
   * 也不被服务端看见，因此不能拿它当去重依据。
   */
  id: string;
  /** 单调递增序号，供增量读取。 */
  seq: number;
  /** 采集时刻（epoch 毫秒）。 */
  time: number;
  level: "debug" | "info" | "warn" | "error";
  /** 模块标识（例如 `remote-server`、`canvas`）。 */
  category: string;
  /** 稳定事件名（例如 `remote-probe-ok`）。 */
  event: string;
  /** 稳定结果/错误码；没有时不出现。 */
  code?: string;
  /** 已脱敏的短说明（人类可读主文本，例如失败原因）；没有时不出现。 */
  message?: string;
  /**
   * 有界、已脱敏的键值细节（例如 `status=502`、`server=host:port`、`phase=probe`），用来补充
   * `message` 说不清的结构化事实；没有合法细节时不出现。
   *
   * 这**不是**任意载荷或原始日志行：键形状、值长度与条数都由宿主投影保证（键
   * `[a-z][a-z0-9._-]{0,31}`、值单行 ≤256 字符、≤16 对），令牌式片段已脱敏。管理端按这些
   * 键展示与搜索，因此键必须稳定；新增键等同扩展展示口径，不能由事件字段临时拼出。
   */
  attributes?: Record<string, string>;
};

/** 宿主诊断缓冲的只读视图（交给可信后端扩展）。 */
export type ApplicationBackendDiagnostics = {
  /**
   * 读取最近的诊断条目（按 `seq` 升序）。
   *
   * `since` 只返回序号大于它的条目；`limit` 截取最新的若干条（有上限，调用方不能要求全量）。
   */
  snapshot(input?: { since?: number; limit?: number }): ApplicationBackendDiagnosticEntry[];
};
