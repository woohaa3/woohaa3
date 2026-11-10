#!/usr/bin/env node
/**
 * 生成 `desktop/runtime-npm-lock.json` 与 `desktop/runtime-npm-measurements.json`。
 *
 * 用法：
 *   node scripts/build-runtime-npm-manifest.mjs            # 重新生成
 *   node scripts/build-runtime-npm-manifest.mjs --check    # 校验已提交产物是否过期
 *   node scripts/build-runtime-npm-manifest.mjs --measure  # 顺带刷新体积基线
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertRuntimeNpmLockCurrent, buildRuntimeNpmLock, measureRuntimeNpmLock } from './lib/runtime-npm-manifest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const lockFile = path.join(root, 'desktop/runtime-npm-lock.json');
const measureFile = path.join(root, 'desktop/runtime-npm-measurements.json');

export function writeRuntimeNpmLock({ measure = false } = {}) {
  const lock = buildRuntimeNpmLock({ clientRoot: root });
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  if (measure) {
    const measurements = measureRuntimeNpmLock({ clientRoot: root, lock });
    fs.writeFileSync(measureFile, `${JSON.stringify(measurements, null, 2)}\n`);
  }
  const summary = Object.entries(lock.engines).map(([id, engine]) => {
    const platforms = Object.keys(engine.platforms);
    const requests = Math.max(...platforms.map((key) => engine.platforms[key].requests));
    return `${id}@${engine.version}（最多 ${requests} 个 tarball 请求/${platforms.length} 平台）`;
  });
  return { lock, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--check')) {
      assertRuntimeNpmLockCurrent({ clientRoot: root });
      process.stdout.write('[runtime-npm] 已提交的 lock 与 pnpm lockfile 一致\n');
    } else {
      const { summary } = writeRuntimeNpmLock({ measure: process.argv.includes('--measure') });
      process.stdout.write(`[runtime-npm] ${summary.join('；')}\n`);
      process.stdout.write(`[runtime-npm] → ${path.relative(root, lockFile)}\n`);
      if (process.argv.includes('--measure')) process.stdout.write(`[runtime-npm] → ${path.relative(root, measureFile)}\n`);
    }
  } catch (error) {
    process.stderr.write(`[runtime-npm] ${error.code ?? 'ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
