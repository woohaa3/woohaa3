# 画布数据库与 COS 分离备份 / 恢复（任务 8.8）

画布存储刻意把**结构化数据**与**媒体 bytes** 分成两个独立持久层：

| 层 | 位置 | 内容 | 备份单元 |
| --- | --- | --- | --- |
| 结构化 | SQLite 文件 / Mongo collections | 画布聚合、revision、operation 幂等记录 | 数据库备份 |
| 媒体 | 腾讯云 COS | 图片/视频/音频 bytes，按 `storageKey` 内容寻址 | COS bucket/prefix 备份或版本控制 |

两者通过 `StoredAsset.metadata.storageKey` 关联。**数据库备份不包含媒体 bytes**，
因此「数据库恢复成功」不等于「完整恢复」。完整恢复必须同时恢复数据库与 COS，并在恢复后
抽检引用。

## 备份

### 结构化数据（metadata-only 归档）

```bash
# 全量导出（metadata-only，不含媒体 bytes）
node scripts/canvas-storage.mjs export --out backup/canvases-$(date +%F).json

# 指定画布
node scripts/canvas-storage.mjs export --out backup/canvas-a.json --canvas canvas-a

# 校验归档（重算 SHA-256、记录数、引用清单）
node scripts/canvas-storage.mjs verify --in backup/canvases-2026-09-23.json

# 校验归档 + 逐一检查 COS 对象存在性与 metadata
node scripts/canvas-storage.mjs verify --in backup/canvases-2026-09-23.json --verify-media
```

归档为 `woohaa3-canvas-archive-v1`，**禁止**任何 Blob、base64、临时/签名 URL 或数据库内部主键。

### 数据库原生备份

- **SQLite**：数据库文件 + 同目录的 `-wal` / `-shm` 一起备份（或先 checkpoint）；归档导出是更可移植的选择。
- **Mongo**：使用 replica set 一致性快照或 `mongodump`；必须包含 `canvases`、`canvas_operations`、`canvas_schema_meta` 三个 collection。

### 媒体（COS）

由**独立运维策略**承担：bucket 版本控制、跨区域复制或生命周期规则。
对象键布局为 `<COS_PREFIX>/media/<storageKey>`。

扩展项目也在同一 Media 持久层中：项目 JSON、输入原件、构建清单/源码包、历史素材与 Vite
静态文件都需要保留。CLI 显式注入扩展导出的只读归档贡献（如 `gameFurnaceArchiveDefinition`），
将完整依赖的稳定键和 metadata 写入每个画布的 `mediaReferences`（不复制 bytes、不启动任务，
停用插件也参与）。Yjs 部署的导出读取 published 投影，避免备份 legacy 表中过期的项目关联。
含扩展项目时导出必须配置 Media 读取能力；项目/依赖缺失或未知版本无法枚举时明确失败，
原文不改写。`verify/import --verify-media` 会检查扩展段，并从已登记项目重新派生依赖以拒绝
不完整清单；旧归档没有该段时也会派生并校验，不因缺少新字段跳过扩展资源。

已演练「只复制引用清单中的对象到独立 Media → 导入新 SQLite → MCP 打开新旧游戏版本」。
漏掉 JS 静态文件时导入在发布画布前拒绝；数据库单独恢复仍不能宣称完整恢复。

## 恢复

CLI `import` 同时重建结构化画布和权威 Yjs checkpoint/projection，使用新 room epoch，
因此 `--replace` 不会被既有 Yjs 文档遮蔽。整个归档先校验；导入中途失败时恢复原聚合、
Yjs checkpoint/updates/已压缩和未压缩的 command 幂等记录，并清理本批次的新画布。
metadata-only 导入创建新同步历史；原始同步/操作历史的完整保留仍需数据库原生备份。

导入前停止画布服务。SQLite CLI 抢占与生产服务相同的持久 writer lock；已有实例持锁时
拒绝写入，dry-run 不抢锁。Mongo 部署目前没有持久 writer lock，导入要求操作员停服后
显式指定 `--offline`，不能保证自动检测其它 writer；Mongo 多表写入依赖 replica set 事务。
若回滚本身失败，命令明确失败，保留数据库原生备份供人工恢复。

```bash
node scripts/canvas-storage.mjs import --in backup/canvas-a.json --replace --verify-media
# Mongo 停服后：
node scripts/canvas-storage.mjs import --in backup/canvas-a.json --replace --verify-media --offline
```


1. 恢复数据库（SQLite 文件或 Mongo 快照）。
2. 恢复 COS bucket/prefix 到同一对象键布局。
3. **抽检引用**（必需）：
   ```bash
   node scripts/canvas-storage.mjs export --out /tmp/restored.json
   node scripts/canvas-storage.mjs verify --in /tmp/restored.json --verify-media
   ```
4. 若 COS 对象缺失，`verify --verify-media` 会以 `missing-cos-object` 失败并列出首个缺失 key。
   **缺失媒体不得报告为完整恢复。**

## 恢复演练（自动）

`web/services/canvas-service/src/storage/core/archive.test.ts` 与
`web/services/canvas-service/src/storage/sqlite/yjs-drill.test.ts` 覆盖：

- metadata-only 归档往返后 contract suite 仍通过随机画布、operation 幂等与资产 storageKey/checksum；
- 仅恢复数据库但 COS 对象缺失时，`verify --verify-media` 明确失败（不伪装完整恢复）。

## 跨数据库迁移

```bash
# SQLite → Mongo
WOOHAA3_CANVAS_STORAGE_BACKEND=sqlite WOOHAA3_CANVAS_STORAGE_SQLITE_PATH=/data/canvas.sqlite \
  node scripts/canvas-storage.mjs export --out /tmp/migration.json
WOOHAA3_CANVAS_STORAGE_BACKEND=mongo MONGODB_URI=... MONGODB_DB=... \
  node scripts/canvas-storage.mjs import --in /tmp/migration.json --dry-run   # 先 dry-run
WOOHAA3_CANVAS_STORAGE_BACKEND=mongo MONGODB_URI=... MONGODB_DB=... \
  node scripts/canvas-storage.mjs import --in /tmp/migration.json --offline
```

迁移**不复制 COS 对象**：目标部署必须能访问同一 bucket/prefix，或由独立 COS 迁移流程先完成对象复制并保持/重写稳定引用。

## 为什么没有「按画布删除 COS 对象」命令

内容寻址 `storageKey` 可能被其它画布、历史记录或正在执行的任务共享。按单个画布删除会误删
共享内容，因此 CLI 不提供该能力；对象回收必须由独立、引用感知且带保留期的生命周期作业处理
（design D8、proposal 非目标）。
