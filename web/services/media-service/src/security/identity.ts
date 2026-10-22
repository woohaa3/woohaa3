/**
 * 服务身份与作用域（change: split-web-runtime-services，任务 3.2 / 1.4）。
 *
 * 内部接口不能只问「令牌对不对」，还要问「这个调用方被允许做什么」：
 * - Canvas 允许 `verify` 和受控媒体读取；
 * - Task 允许 `verify` / `sign` / `import`。
 *
 * 这样「非 Task 调用方无法取得签名 URL」是**结构性**的：Canvas 的令牌根本没有 `sign`
 * 作用域，而不是依赖某个 `if`。（spec「非任务调用方请求签名」。）
 */
export type MediaScope = "verify" | "sign" | "import" | "read" | "write";

export type ServiceIdentity = {
  name: string;
  scopes: readonly MediaScope[];
};

const ALL_SCOPES: readonly MediaScope[] = ["verify", "sign", "import"];

/**
 * 从入站请求解析服务身份。
 *
 * 首版用静态令牌表（可放环境变量或测试注入）。未配置任何令牌时**拒绝所有内部请求**，
 * 因为「无身份」不能等同于「全权」。loopback 不自动放行内部协议（与公开画布 API 的
 * 默认边界不同：内部接口是服务间接口）。
 */
export type ServiceIdentityConfig = {
  /** 服务名 → 令牌。 */
  tokens: Record<string, string>;
  /** 服务名的作用域；缺省按名字推断（canvas=verify/read，task=verify/sign/import）。 */
  scopes?: Record<string, readonly MediaScope[]>;
};

export function resolveServiceIdentity(
  token: string | undefined,
  config: ServiceIdentityConfig
): ServiceIdentity | null {
  if (!token) return null;
  for (const [name, expected] of Object.entries(config.tokens)) {
    if (expected === "" || expected !== token) continue;
    return { name, scopes: config.scopes?.[name] ?? defaultScopes(name) };
  }
  return null;
}

export function defaultScopes(name: string): readonly MediaScope[] {
  if (name === "application" || name === "application-service") return ["verify", "read", "write"];
  if (name === "canvas" || name === "canvas-service") return ["verify", "read"];
  if (name === "task" || name === "task-service") return ALL_SCOPES;
  return [];
}

export function hasScope(identity: ServiceIdentity, scope: MediaScope): boolean {
  return identity.scopes.includes(scope);
}

export function parseServiceIdentityConfig(env: Record<string, string | undefined>): ServiceIdentityConfig {
  return {
    tokens: {
      "application-service": (env.WOOHAA3_APPLICATION_SERVICE_TOKEN ?? "").trim(),
      "canvas-service": (env.WOOHAA3_CANVAS_SERVICE_TOKEN ?? "").trim(),
      "task-service": (env.WOOHAA3_TASK_SERVICE_TOKEN ?? "").trim()
    }
  };
}
