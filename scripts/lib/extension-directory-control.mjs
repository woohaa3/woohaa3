/**
 * 扩展目录的安装/卸载（改名）。
 *
 * 目录名只表达「装没装」：`foo` 是已安装，`.foo` 是未安装。**启用/停用不在这里**——
 * 那是站点控制面的 `desiredEnabled`，在运行中经 Cordis 宿主启停，不需要改文件系统
 * （change: 2026-10-19-restore-runtime-extension-toggling，design D1/D2/D6）。
 *
 * 本模块只读声明与 JSON，不执行扩展代码。改名只允许发生在配置里声明为可写根的根内，
 * 否则管理员能把受版本控制的目录改走。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXTENSION_PACKAGE_PREFIX } from './extension-scan.mjs';
import { extensionIconPublicPath } from './extension-icon-assets.mjs';

export class ExtensionDirectoryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 取第一个非空字符串版本号；声明缺省/空白时返回 undefined（调用方不展示版本）。 */
function firstVersion(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
}

export function createExtensionDirectoryControl({ roots, writableRoots = [], metadata = [], devExtensions = [], allowlist = null, onRename = () => {} }) {
  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const inventory = () => {
    const rows = [];
    const devIds = new Set(devExtensions.map((record) => record.extensionId));
    const candidates = roots.flatMap((root) => fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .map((entry) => ({ root, name: entry.name, directory: path.join(root, entry.name), dev: false })));
    candidates.push(...devExtensions.map((record) => ({ root: path.dirname(record.dir), name: path.basename(record.dir), directory: record.dir, dev: true })));
    for (const { root, name, directory, dev } of candidates) {
      const pkg = readJson(path.join(directory, 'package.json'));
      if (!dev && (typeof pkg?.name !== 'string' || !pkg.name.startsWith(EXTENSION_PACKAGE_PREFIX))) continue;
      const descriptor = readJson(path.join(directory, 'extension.json'));
      const browser = readJson(path.join(directory, 'browser-dist/artifact-manifest.json'))?.metadata;
      // 共享库（runtime-foundation）与测试 fixture（sample-site-extension）既没有 extension.json
      // 也没有 browser 产物，不是插件；browser-only 扩展（dev-performance 等）只有 browser metadata，
      // 仍必须出现在清单里。
      if (!descriptor && !browser) continue;
      const id = descriptor?.extensionId ?? browser?.extensionId ?? pkg?.name?.slice(EXTENSION_PACKAGE_PREFIX.length);
      if (typeof id !== 'string' || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id)) continue;
      if (!dev && devIds.has(id)) continue;
      const known = metadata.find((item) => item.extensionId === id);
      // 图标优先级：已声明 metadata / browser metadata → 品牌图形约定路径 → 后端语义 glyph。
      // 品牌图形先于 glyph（两者都给时品牌图形更具体），未知 glyph 由前端回退通用图标。
      const glyph = typeof descriptor?.icon?.glyph === 'string' ? descriptor.icon.glyph : undefined;
      const brand = descriptor ? extensionIconPublicPath(descriptor, id) : null;
      const icon = known?.icon ?? browser?.icon ?? brand ?? glyph;
      // 版本只取声明值，不从文件名或发布时间猜。优先级即部署口径：
      // 1) extension.json 的 site.version —— 站点控制面与站点目录用的同一份声明；
      // 2) 已加载的可信元数据（provider metadata 导出，没有 site 段的 Provider 走这里）；
      // 3) 浏览器产物的 artifact metadata；4) package.json 兜底。都没有就不展示。
      const version = firstVersion(descriptor?.site?.version, known?.version, browser?.version, descriptor?.version, pkg?.version);
      rows.push({ id, directory, root, name,
        label: known?.name ?? descriptor?.site?.name ?? browser?.label ?? id,
        description: known?.description ?? descriptor?.site?.description ?? browser?.description ?? '',
        ...(icon ? { icon } : {}),
        ...(version ? { version } : {}),
        // 部署白名单（WOOHAA3_EXTENSION_ALLOWLIST）之外的按未安装处理；开发者登记目录是显式意愿，不受它限制。
        installed: dev || (!name.startsWith('.') && (allowlist === null || allowlist.has(id))),
        writable: !dev && writableRoots.includes(root),
        bootstrap: Boolean(descriptor?.bootstrap),
        dependencies: Array.isArray(descriptor?.site?.dependencies) ? descriptor.site.dependencies.filter((value) => typeof value === 'string') : [] });
    }
    return rows.sort((a, b) => a.id.localeCompare(b.id) || a.directory.localeCompare(b.directory));
  };
  const reasonFor = (row, rows) => {
    if (rows.filter((item) => item.id === row.id).length !== 1) return new ExtensionDirectoryError('EXTENSION_DIRECTORY_DUPLICATE', '扩展标识重复，请先手动整理目录');
    if (!row.writable) return new ExtensionDirectoryError('EXTENSION_DIRECTORY_READONLY', '该扩展根未声明为可写根，请调整部署配置');
    try { fs.accessSync(row.root, fs.constants.W_OK | fs.constants.X_OK); } catch {
      return new ExtensionDirectoryError('EXTENSION_DIRECTORY_READONLY', '扩展根目录不可写，请调整目录权限');
    }
    return undefined;
  };
  /** 只有具名安装态条目才出现在面板里；与扫描口径一致（`.` 前缀 = 未安装，不展示）。 */
  const visible = () => inventory().filter((row) => row.installed);
  return {
    /** 本次启动已安装的扩展（`/api/settings` 的 `installedExtensions`）。 */
    list() {
      return visible().map((row) => ({ id: row.id, label: row.label, description: row.description,
        directory: row.directory, ...(row.icon ? { icon: row.icon } : {}),
        ...(row.version ? { version: row.version } : {}), writable: row.writable }));
    },
    /**
     * 安装或卸载一个扩展目录：`installed=false` 加 `.` 前缀，`true` 去掉前缀。
     * 影响下一次启动的扫描与装配，不改变当前进程的运行状态。
     */
    setInstalled(id, installed) {
      const rows = inventory();
      const matches = rows.filter((row) => row.id === id);
      if (matches.length !== 1) {
        throw new ExtensionDirectoryError('EXTENSION_DIRECTORY_MISSING',
          matches.length ? '扩展标识重复，请先手动整理目录' : '扩展目录不存在，请刷新后重试');
      }
      const row = matches[0];
      if (row.installed === installed) return;
      const reason = reasonFor(row, rows);
      if (reason) throw reason;
      if (row.bootstrap) throw new ExtensionDirectoryError('EXTENSION_DIRECTORY_BOOTSTRAP', '基础提供者不能在这里卸载，请先调整部署配置');
      if (installed) {
        const missing = row.dependencies.find((dep) => !rows.some((item) => item.installed && item.id === dep));
        if (missing) throw new ExtensionDirectoryError('EXTENSION_DIRECTORY_DEPENDENCY', `请先安装依赖插件：${missing}`);
      } else {
        const dependent = rows.find((item) => item.installed && item.id !== row.id && item.dependencies.some((dep) => dep === row.id));
        if (dependent) throw new ExtensionDirectoryError('EXTENSION_DIRECTORY_DEPENDENT', `请先卸载依赖它的插件：${dependent.label}`);
      }
      const target = path.join(row.root, installed ? row.name.replace(/^\.+/, '') : `.${row.name}`);
      // 不覆盖文件、软链或已有目录；操作在同一根目录内同步串行完成。
      try { fs.lstatSync(target); throw new ExtensionDirectoryError('EXTENSION_DIRECTORY_EXISTS', '目标目录已存在，请先手动处理同名目录'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.renameSync(row.directory, target);
      onRename(row.directory, target);
    }
  };
}
