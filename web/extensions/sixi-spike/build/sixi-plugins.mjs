/**
 * 四喜侧构建插件（只在这个扩展的构建期运行，不进入产物）。
 *
 * 1. `@/` → 四喜仓库的 src：四喜用 Vite 的别名，esbuild 不认识。
 * 2. `import.meta.glob('...', { query: '?raw', import: 'default', eager: true })`：
 *    四喜用它把能力包的 SKILL.md 内联进包。Vite 专有语法，esbuild 不认，
 *    这里在构建期展开成一份静态 import 表（只支持 eager + ?raw，其余形态直接报错，不猜）。
 */
import fs from "node:fs";
import path from "node:path";

const GLOB_CALL = /import\.meta\.glob\(\s*(['"])([^'"]+)\1\s*(?:,\s*\{([^}]*)\})?\s*\)/g;

/** 只实现了四喜实际用到的形态；其它形态必须显式失败，避免静默产出空表。 */
function expandGlob({ pattern, options, file }) {
  const raw = /\bquery:\s*['"]\?raw['"]/.test(options);
  const eager = /\beager:\s*true\b/.test(options);
  const asDefault = /\bimport:\s*['"]default['"]/.test(options);
  if (!raw || !eager || !asDefault) {
    throw new Error(
      `import.meta.glob 只支持 { query: '?raw', import: 'default', eager: true }：${path.relative(process.cwd(), file)}`
    );
  }
  if (!pattern.startsWith("./")) {
    throw new Error(`import.meta.glob 只支持以 ./ 开头的相对模式：${pattern}`);
  }
  const dir = path.dirname(file);
  const segments = pattern.slice(2).split("/");
  const literal = [];
  while (segments.length && !segments[0].includes("*")) literal.push(segments.shift());
  const rest = segments.join("/");
  const baseDir = path.join(dir, ...literal);
  if (!rest) {
    throw new Error(`import.meta.glob 模式不含通配符：${pattern}`);
  }
  // 支持两种形态: './目录/*.ext'（直接子文件）与 './目录/*/文件名'（一级子目录）。
  const direct = rest.match(/^\*\.([\w.]+)$/);
  const nested = rest.match(/^\*\/([^/*]+)$/);
  if (!direct && !nested) {
    throw new Error(`import.meta.glob 只支持 './目录/*.ext' 或 './目录/*/文件名' 形式：${pattern}`);
  }
  if (!fs.existsSync(baseDir)) return [];
  const rows = [];
  if (direct) {
    const ext = `.${direct[1]}`;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
      const abs = path.join(baseDir, entry.name);
      rows.push([`./${[...literal, entry.name].join("/")}`, abs]);
    }
  } else {
    const leaf = nested[1];
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(baseDir, entry.name, leaf);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      rows.push([`./${[...literal, entry.name, leaf].join("/")}`, abs]);
    }
  }
  return rows
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    // 生成对象字面量的成员：`"key": "内容"`。调用方把它拼进 `{ ... }`。
    .map(([key, abs]) => `${JSON.stringify(key)}: ${JSON.stringify(fs.readFileSync(abs, "utf8"))}`);
}

/**
 * 从扩展目录向上找四喜仓库根（以 `src/app/App.tsx` 为标记），不写死层数：
 * 扩展将来可能被挪到别的根下，层数一变别名就全断。
 */
function findSixiRoot(from) {
  let dir = path.resolve(from);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(dir, "src", "app", "App.tsx"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`从 ${from} 向上找不到四喜仓库根（缺 src/app/App.tsx）`);
}

export default function sixiSourcePlugins({ extensionDir }) {
  const sixiSrc = path.join(findSixiRoot(extensionDir), "src");
  return [
    {
      name: "sixi-alias",
      setup(build) {
        build.onResolve({ filter: /^@\// }, (args) => {
          const base = path.join(sixiSrc, args.path.slice(2));
          for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate };
          }
          return { errors: [{ text: `无法解析四喜别名：${args.path}（在 ${path.basename(args.importer)} 中）` }] };
        });
      }
    },
    {
      name: "sixi-import-meta-glob",
      setup(build) {
        build.onLoad({ filter: /\.[jt]sx?$/ }, (args) => {
          if (!fs.existsSync(args.path)) return null;
          const source = fs.readFileSync(args.path, "utf8");
          if (!source.includes("import.meta.glob")) return null;
          const entries = [];
          let index = 0;
          const contents = source.replace(GLOB_CALL, (_match, _quote, pattern, options) => {
            const rows = expandGlob({ pattern, options: options ?? "", file: args.path });
            const mapName = `__woohaaGlob${index++}`;
            entries.push(`const ${mapName} = { ${rows.join(", ")} };`);
            return mapName;
          });
          return { contents: `${entries.join("\n")}\n${contents}`, loader: args.path.endsWith("x") ? "tsx" : "ts" };
        });
      }
    }
  ];
}
