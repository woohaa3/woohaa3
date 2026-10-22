/** Invoke pnpm without a shell; Windows batch shims are not executables. */
export function packageManagerInvocation(args, { env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
  const entry = env.npm_execpath;
  if (entry && /\.(?:c?js|mjs)$/i.test(entry)) return { command: execPath, args: [entry, ...args] };
  if (entry && /\.exe$/i.test(entry)) return { command: entry, args };
  if (platform !== 'win32') return { command: 'pnpm', args };
  throw new Error('无法定位 pnpm JavaScript 或 exe 入口；请通过 pnpm run build:plugins / pnpm desktop:bundle 启动构建。');
}
