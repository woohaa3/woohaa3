/**
 * Web host 运行环境。
 *
 * 与桌面宿主同一原则：**不继承**宿主 shell 里的 `WOOHAA3_*` / 数据库 / 端口配置，只接受本
 * 目录与显式 CLI 参数。npm registry runtime 与桌面共用同一 manager / app-local Node+npm；
 * 关闭安装只改变策略值，API 会把原因如实报给连接与设置页。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function buildWebHostEnvironment({ resourceRoot, dataDir, host, port, basePath, runtimeInstall = 'enabled', agentRuntime = null, baseEnv = process.env }) {
  const data = (name) => path.join(dataDir, name);
  for (const dir of ['stores', 'media', 'config', 'secrets', 'extension-data', 'extensions', 'extensions-managed', 'logs', 'cache']) {
    fs.mkdirSync(data(dir), { recursive: true, mode: 0o700 });
  }
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith('WOOHAA3_') || key.startsWith('VITE_') || ['MONGODB_URI', 'MONGODB_DB', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'production',
    HOST: host,
    PORT: String(port),
    WOOHAA3_BASE_PATH: basePath,
    WOOHAA3_REPO_ROOT: resourceRoot,
    WOOHAA3_TASK_STORE_PATH: data('stores/task.sqlite'),
    WOOHAA3_APPLICATION_STORE_PATH: data('stores/application.sqlite'),
    WOOHAA3_CANVAS_STORAGE_BACKEND: 'sqlite',
    WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: data('stores/canvas.sqlite'),
    WOOHAA3_APPLICATION_DOCUMENT_STORE_BACKEND: 'sqlite',
    WOOHAA3_CONFIG_FILE: data('config/woohaa.config.yml'),
    WOOHAA3_SECRETS_FILE: data('config/woohaa.secrets.yml'),
    WOOHAA3_PLUGIN_SECRET_DIR: data('secrets/plugins'),
    WOOHAA3_EXTENSION_DATA_DIR: data('extension-data'),
    WOOHAA3_LOG_DIR: data('logs'),
    WOOHAA3_MODELS_CONFIG_PATH: fs.existsSync(data('config/models.json')) ? data('config/models.json') : path.join(resourceRoot, 'models.json'),
    WOOHAA3_EXTENSION_DIRS: [path.join(resourceRoot, 'extensions'), data('extensions')].join(','),
    WOOHAA3_EXTENSION_WRITABLE_DIRS: data('extensions'),
    /**
     * 独立执行器（`woohaa3-executor` daemon）的连接信息。
     *
     * 三个变量缺任一，宿主就不装配 `agentRuntime`，于是声明了 `executors` 的扩展
     * （sdk-agent / local-agent / oauth-agent）拿不到执行器能力——Provider 语言模型
     * 因此不会投影成助手连接，文本节点与导演台看不到它们。dev 与桌面启动器一直有这条，
     * web host 形态长期缺失，这里补上。
     *
     * 由启动器在 `ensure()` 之后传入；缺失时保持不注入（执行器不可用是合法状态）。
     */
    ...(agentRuntime ? {
      WOOHAA3_AGENT_RUNTIME_SOCKET: agentRuntime.socketPath,
      WOOHAA3_AGENT_RUNTIME_TOKEN: agentRuntime.token,
      WOOHAA3_AGENT_WORKSPACE_KEY: agentRuntime.workspaceKey
    } : {}),
    /**
     * 受管安装根（市场安装落盘处）必须放在**数据目录**，不能留在资源根。
     *
     * 资源根随版本替换：`scripts/deploy-web-host.mjs` 的切换步骤里有
     * `rm -rf <resourceRoot>`（强制重新释放 payload），放在那里的 `installations.json` 与
     * `installed/<id>/<version>/` 会随每次部署一起消失，表现成「市场装过的扩展部署后没了」。
     * 与 release（`shared/extensions-managed`）和桌面（数据目录）保持同一原则。
     *
     * 缺省值 `resolveManagedRoot` 是 `<repoRoot>/.woohaa3/extensions`，在 web host 里
     * `repoRoot` 正是资源根——所以必须显式给出，否则默认就落在会被删的位置。
     */
    WOOHAA3_EXTENSION_MANAGED_DIR: data('extensions-managed'),
    // npm registry runtime：与桌面同一 manager / 同一 app-local Node+npm；缓存写在数据目录。
    WOOHAA3_RUNTIME_DATA_DIR: dataDir,
    WOOHAA3_RUNTIME_DEFAULTS_FILE: path.join(resourceRoot, 'runtime-downloads.json'),
    WOOHAA3_RUNTIME_LOCK_FILE: path.join(resourceRoot, 'runtime-components.lock.json'),
    WOOHAA3_RUNTIME_NPM_LOCK_FILE: path.join(resourceRoot, 'runtime-npm-lock.json'),
    WOOHAA3_RUNTIME_TOOLS_DIR: path.join(resourceRoot, 'tools'),
    WOOHAA3_RUNTIME_INSTALL: runtimeInstall,
    ...(baseEnv.WOOHAA_WEB_HOST_RUNTIME_REGISTRY ? { WOOHAA3_RUNTIME_REGISTRY: baseEnv.WOOHAA_WEB_HOST_RUNTIME_REGISTRY } : {})
  });
  // 主密钥：存在则复用，不存在首次生成后固定（凭据密文的解密依赖它，绝不能每次启动重算）。
  const master = data('secrets/master.key');
  if (fs.existsSync(master)) env.WOOHAA3_PLUGIN_SECRET_MASTER_KEY = fs.readFileSync(master, 'utf8').trim();
  else {
    const key = randomBytes(32).toString('base64');
    fs.writeFileSync(master, key, { mode: 0o600 });
    env.WOOHAA3_PLUGIN_SECRET_MASTER_KEY = key;
  }
  return env;
}
