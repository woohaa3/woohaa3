/**
 * 日志脱敏（对应 change: unify-host-client-logging 的 design D5）。
 *
 * **这是全仓唯一一张模式表**。宿主日志出口、导出兜底、（未来的）桌面壳导出都读这里，
 * 不要再在调用点各写一份正则——[host/base/diagnostics.ts] 里原来的 `sanitizeDiagnosticText`
 * 已经收敛到这里。
 *
 * 口径与取舍：
 * - 只处理**已知形状**的凭据（Bearer、`token=`、`secret=:`、URL 内嵌口令）。命中率靠
 *   "业务不该把凭据写进日志"这条调用方约定兜底，而不是靠正则猜。
 * - **刻意不做高熵字符串自动打码**：那会把 traceId、内容哈希、媒体 ID 一起打掉，而这些
 *   恰恰是排障时最需要的东西。误伤比漏判更难排查。
 */
import { LOG_ATTRIBUTE_VALUE_LIMIT, logText } from "./value.js";

/** 替换后的稳定占位；导出与在线日志用同一个，便于检索。 */
export const REDACTED = "[redacted]";

/**
 * 模式表。顺序有意义：先处理带 key 的（能保留 key 便于确认确实是凭据字段），
 * 再处理裸令牌形状（`Bearer`），最后处理 URL 里的 userinfo。
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // `token=xxx` / `?access_token=xxx` / `&signature=xxx`：保留参数名，值整体替换。
  [
    /([?&;](?:token|access_token|refresh_token|session_token|device_code|user_code|sig|signature|x-amz-signature|key|api_key|password|secret)=)[^&\s]*/gi,
    `$1${REDACTED}`
  ],
  // `Authorization: Bearer xxx` / `Authorization: Basic xxx`：连方案词一起替换。
  //
  // 必须排在通用 key/value 规则**之前**：否则通用规则会把 `Bearer` 当成值、只换掉它，
  // 真正的令牌原样留在后面（这正是首版测试抓到的缺陷）。
  [/(authorization\s*[:=]\s*)(?:[a-z]+\s+)?[^\s,;&]+/gi, `$1${REDACTED}`],
  // `token: xxx` / `password="xxx"` 这类 key/value 文本。
  // 负向断言跳过 `Bearer`：授权头已经由上一条处理，这里不能再把方案词当值替换。
  [
    /((?:token|secret|password|passwd|api[_-]?key|access[_-]?key|cookie|credential|device[_-]?code|user[_-]?code)\s*[:=]\s*)(?![Bb]earer\s)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    `$1${REDACTED}`
  ],
  // 裸 `Bearer <token>`（前面没有 key 名）。
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  // URL 里的 userinfo：`https://user:pass@host`。
  [/(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`]
];

/**
 * 值的键名是否承载凭据。
 *
 * 命中时**不丢弃整个键**，而是把值替换成占位：键名本身不敏感，保留它能确认"确实尝试记录过
 * 这个字段"，丢掉反而会让排障怀疑字段是不是根本没传。
 */
const FORBIDDEN_KEY = /token|secret|password|passwd|authorization|cookie|credential|api[_-]?key|access[_-]?key|device[_-]?code|user[_-]?code/i;

/** 键名是否属于"值必须被打码"的那类。 */
export function isSensitiveLogKey(key: string): boolean {
  return FORBIDDEN_KEY.test(key);
}

/**
 * 对一段已经成型的文本做模式级脱敏。**不做截断**：调用方各自决定上限。
 *
 * 单独暴露是因为导出兜底要对**整行**（可能已经拼接好的 JSON 行）再跑一遍，那时没有字段结构。
 */
export function redactLogPatterns(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of REDACTIONS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/**
 * 日志文本的完整脱敏入口：折叠单行 + 模式替换 + 截断。
 *
 * 调用顺序不能反：先折叠成单行，否则跨行的 `token: \n xxx` 会漏掉；再脱敏；最后截断，
 * 避免截断把 `[redacted]` 从中间切断。
 */
export function redactLogText(value: unknown, limit = LOG_ATTRIBUTE_VALUE_LIMIT): string {
  return logText(redactLogPatterns(logText(value, Number.MAX_SAFE_INTEGER)), limit);
}
