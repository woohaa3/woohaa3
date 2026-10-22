export type RuntimeSource = 'managed' | 'local';
export interface RuntimeConfig { source: RuntimeSource; path?: string }
export interface RuntimeComponentState {
  id: string; version: string; source: RuntimeSource; configured: boolean;
  status: 'missing' | 'checking' | 'downloading' | 'verifying' | 'extracting' | 'ready' | 'failed' | 'incompatible';
  entry?: string; kind?: 'executable' | 'node' | 'asset'; progress?: { received: number; total: number }; error?: string;
}
export interface RuntimeHandle { entry: string; version: string; source: RuntimeSource; kind: 'executable' | 'node' | 'asset'; release(): void }
export interface RuntimeComponentManager {
  readonly configPath: string;
  inspect(id: string): Promise<RuntimeComponentState>;
  list(): Promise<RuntimeComponentState[]>;
  configure(id: string, config: RuntimeConfig): Promise<RuntimeComponentState>;
  install(id: string, options?: { signal?: AbortSignal }): Promise<RuntimeComponentState>;
  resolve(id: string): Promise<RuntimeHandle>;
  remove(id: string): Promise<RuntimeComponentState>;
  discoverLocal(id: string): Promise<Omit<RuntimeHandle, 'release'>[]>;
}
export class RuntimeComponentError extends Error { code: string; constructor(code: string, message: string) }
export function createRuntimeComponentManager(options: { dataDir: string; defaultsPath: string; lockPath: string; platform?: string; arch?: string; fetchImpl?: typeof fetch }): RuntimeComponentManager;
export function getRuntimeComponentManager(): RuntimeComponentManager | undefined;
