export type RuntimeSource = 'managed' | 'npm-registry' | 'local';
export interface RuntimeConfig { source: RuntimeSource; path?: string }
export type RuntimeStatus =
  | 'missing' | 'checking' | 'downloading' | 'verifying' | 'extracting' | 'preparing'
  | 'ready' | 'failed' | 'incompatible' | 'unavailable';
export interface RuntimeComponentState {
  id: string; version: string; source: RuntimeSource; configured: boolean;
  status: RuntimeStatus;
  entry?: string; kind?: 'executable' | 'node' | 'asset'; progress?: { received: number; total: number }; error?: string;
  /** npm registry 引擎信息（缺省表示该组件只有 CDN/本机来源）。 */
  engine?: string; registry?: string; requests?: number;
}
export interface RuntimeHandle { entry: string; version: string; source: RuntimeSource; kind: 'executable' | 'node' | 'asset'; release(): void }
export interface RuntimeInstallPolicy { installEnabled: boolean; sources: RuntimeSource[]; registry: string | null }
export interface RuntimeComponentManager {
  readonly configPath: string;
  inspect(id: string): Promise<RuntimeComponentState>;
  list(): Promise<RuntimeComponentState[]>;
  configure(id: string, config: RuntimeConfig): Promise<RuntimeComponentState>;
  install(id: string, options?: { signal?: AbortSignal }): Promise<RuntimeComponentState>;
  resolve(id: string): Promise<RuntimeHandle>;
  remove(id: string): Promise<RuntimeComponentState>;
  discoverLocal(id: string): Promise<Omit<RuntimeHandle, 'release'>[]>;
  /** Inspect an explicitly chosen local path without installing or configuring it. */
  diagnose(id: string, executable: string): Promise<Omit<RuntimeHandle, 'release'> | { error: string }>;
  /** Deployment-visible install policy; Web host关闭安装时用于明确报不可用。 */
  policy(): RuntimeInstallPolicy;
}
export class RuntimeComponentError extends Error { code: string; constructor(code: string, message: string) }
export function createRuntimeComponentManager(options: {
  dataDir: string; defaultsPath: string; lockPath: string;
  /** 构建期发布的 npm registry 精确锁；缺省时不提供 npm-registry source。 */
  npmLockPath?: string | null;
  /** 随包的 app-local 工具目录（内含 npm CLI）；缺省时跳过 npm 工具链探测。 */
  toolsDir?: string | null;
  /** 受管 npm mirror；缺省读 defaults.registry.baseUrl 或 npm 官方 registry。 */
  registryUrl?: string | null;
  /** 部署显式关闭运行期安装（false 时 npm-registry 组件返回 unavailable）。 */
  installEnabled?: boolean;
  nodeExecPath?: string;
  platform?: string; arch?: string; fetchImpl?: typeof fetch;
}): RuntimeComponentManager;
export function getRuntimeComponentManager(): RuntimeComponentManager | undefined;
