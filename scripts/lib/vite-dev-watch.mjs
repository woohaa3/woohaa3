import path from 'node:path';

/** Build output is served on demand; only source files need HMR watches. */
export function devWatchResilience({ outDir }) {
  const output = path.resolve(outDir);
  const generated = file => {
    const relative = path.relative(output, path.resolve(file));
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  };
  let dispose = () => {};
  return {
    name: 'dev-watch-resilience',
    apply: 'serve',
    config() {
      return { server: { watch: { ignored: [output.replaceAll('\\', '/'), output.replaceAll('\\', '/') + '/**'] } } };
    },
    configureServer(server) {
      const retries = new Map();
      const timers = new Set();
      let closed = false;
      const onError = error => {
        if (error.code !== 'EBUSY') throw error;
        const file = error.path ?? error.filename;
        server.config.logger.warn(`[dev-watch] 文件暂时被占用，开发服务继续运行：${file ?? error.message}`);
        if (!file || generated(file)) return;
        const attempt = retries.get(file) ?? 0;
        if (attempt >= 3) {
          server.config.logger.error(`[dev-watch] 重试后仍无法监听：${file}；请解除文件占用后重启开发服务。`);
          return;
        }
        retries.set(file, attempt + 1);
        const timer = setTimeout(async () => {
          timers.delete(timer);
          if (closed) return;
          try {
            await server.watcher.unwatch(file);
            if (!closed) server.watcher.add(file);
          } catch (error) {
            if (!closed) server.config.logger.error(`[dev-watch] 恢复监听失败：${error.message}`);
          }
        }, [100, 400, 1000][attempt]);
        timers.add(timer);
      };
      server.watcher.on('error', onError);
      dispose = () => {
        closed = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        server.watcher.off('error', onError);
      };
      server.httpServer?.once('close', dispose);
    },
    closeBundle() { dispose(); },
  };
}
