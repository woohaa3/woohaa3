/**
 * 素材库：用户从网页收进来的图片，**不属于任何画布**。
 *
 * ## 与画布资产的区别
 *
 * 画布资产活在某个画布的 `assets` 里，跟着画布同步、随画布删除而消失。
 * 素材库是跨画布的收集箱：先攒下来，用的时候才挑一张放进画布。
 * 两者不能混成一个列表 —— 混了之后「删画布会不会连素材一起删」就没有干净答案。
 *
 * ## 为什么只存元数据
 *
 * 字节走 `ctx.media`（内容寻址、按 SHA-256 去重），素材库只记「哪些媒体对象被收进来了」。
 * 同一张图被保存两次，媒体层只留一份字节，这里也只留一条记录 —— 重复保存是幂等的。
 *
 * ## 持久化
 *
 * JSON 文件，与宿主其它本机库同目录（`dirname(任务库路径)/library.json`）。
 * 到几千条时会变慢；真要扩容时换 SQLite，对外的接口不变。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** 一条素材。字段与扩展 / 前端的视图一一对应。 */
export type LibraryItem = {
  /** 内容哈希。同时是去重键：同一张图重复保存只会得到同一条。 */
  id: string;
  title: string;
  /** 保存时实际下载的地址（Pinterest 的缩略图地址会被升级成原图）。 */
  sourceUrl: string;
  /** 打开它的页面地址，仅用于展示「从哪儿来的」。 */
  pageUrl?: string;
  /** 媒体对象的稳定同源地址（`/api/media/<key>`）。 */
  url: string;
  storageKey: string;
  contentType: string;
  bytes: number;
  /** 毫秒时间戳。 */
  createdAt: number;
};

type LibraryFile = {
  version: 1;
  items: LibraryItem[];
};

/**
 * 空库。
 *
 * **必须是函数而不是常量**：`{ ...EMPTY }` 只复制对象、不复制里面的数组，
 * 常量会让所有调用方共享同一个 `items`，`put` 往里 push 时就把别的实例的数据也写进去了
 * （表现为「换了个文件却读出上一批条目」）。
 */
const emptyFile = (): LibraryFile => ({ version: 1, items: [] });

/** 素材库最多保留多少条。防止一次误操作把索引写成几 MB。 */
export const MAX_ITEMS = 5_000;

export type LibraryStore = {
  list(): Promise<LibraryItem[]>;
  /** 收进来。同样的 id 已存在时返回旧记录并标记 `duplicated`。 */
  put(item: LibraryItem): Promise<{ item: LibraryItem; duplicated: boolean }>;
  remove(id: string): Promise<boolean>;
  path(): string;
};

export function createLibraryStore(file: string): LibraryStore {
  // 所有写操作串行化：读-改-写不加锁会互相覆盖，后完成的那次把先完成的那条丢掉。
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    // 失败不能卡住后续操作
    queue = run.catch(() => undefined);
    return run;
  };

  const read = async (): Promise<LibraryFile> => {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as LibraryFile;
      if (!Array.isArray(parsed?.items)) return emptyFile();
      return { version: 1, items: parsed.items.filter(isItem) };
    } catch {
      // 文件不存在、JSON 坏了都当作空库：素材库是派生数据，
      // 打不开远好于「素材页整个报错」。
      return emptyFile();
    }
  };

  const write = async (data: LibraryFile): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    // 先写临时文件再改名：中途失败不会留下半个 JSON。
    await rename(tmp, file);
  };

  return {
    path: () => file,

    list: () => read().then((data) => [...data.items].sort((a, b) => b.createdAt - a.createdAt)),

    put: (item) =>
      serialize(async () => {
        const data = await read();
        const existing = data.items.find((entry) => entry.id === item.id);
        // 已存在就不覆盖：保留最早那次保存的时间和来源，
        // 「重复保存」不该改写这条素材的历史。
        if (existing) return { item: existing, duplicated: true };
        data.items.push(item);
        if (data.items.length > MAX_ITEMS) {
          // 按时间保留最新的，超出上限的旧条目直接丢弃索引
          data.items.sort((a, b) => b.createdAt - a.createdAt);
          data.items.length = MAX_ITEMS;
        }
        await write(data);
        return { item, duplicated: false };
      }),

    remove: (id) =>
      serialize(async () => {
        const data = await read();
        const next = data.items.filter((entry) => entry.id !== id);
        if (next.length === data.items.length) return false;
        await write({ version: 1, items: next });
        return true;
      })
  };
}

/** 只认形状对得上的条目：索引可能被旧版本或手工编辑过。 */
function isItem(value: unknown): value is LibraryItem {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.storageKey === "string" &&
    typeof entry.url === "string" &&
    typeof entry.createdAt === "number"
  );
}
