/**
 * Mongo driver 的最小可注入面（任务 6.1 / 6.3）。
 *
 * 与媒体服务的 COS adapter 注入 `CosLike` 的做法一致：adapter 只依赖这一小组方法，
 * 因此可以在没有真实 mongod 的环境里用内存 fake 跑同一套 contract 断言，也能在集成
 * 环境注入真实 `MongoClient`。
 *
 * 刻意只暴露聚合所需能力：**没有** GridFS、没有二进制上传、没有 blob collection 概念。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import type { CanvasRepository } from "../core/index.js";

export type MongoCanvasDoc = {
  _id: string;
  revision: number;
  title: string;
  canvas: ServerCanvas;
  createdAt: string;
  updatedAt: string;
};

export type MongoOperationDoc = {
  canvasId: string;
  operationId: string;
  baseRevision: number;
  resultRevision: number;
  actorId: string;
  commands: unknown[];
  resultCanvas: ServerCanvas;
  createdAt: string;
};

export type MongoUpdateResult = { matchedCount: number; modifiedCount: number };
export type MongoDeleteResult = { deletedCount: number };
export type MongoInsertResult = { insertedId: unknown };

/** 一个 collection 的最小面。`session` 参数用于事务。 */
export type MongoCollectionLike<TDoc> = {
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<string>;
  findOne(filter: Record<string, unknown>, options?: { session?: unknown; projection?: Record<string, 0 | 1> }): Promise<TDoc | null>;
  find(filter: Record<string, unknown>, options?: { projection?: Record<string, 0 | 1> }): {
    sort(spec: Record<string, 1 | -1>): {
      skip(count: number): {
        limit(count: number): { toArray(): Promise<TDoc[]> };
      };
    };
  };
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
  insertOne(doc: TDoc, options?: { session?: unknown }): Promise<MongoInsertResult>;
  updateOne(
    filter: Record<string, unknown>,
    update: { $set: Record<string, unknown> },
    options?: { session?: unknown; upsert?: boolean }
  ): Promise<MongoUpdateResult>;
  deleteOne(filter: Record<string, unknown>, options?: { session?: unknown }): Promise<MongoDeleteResult>;
  deleteMany(filter: Record<string, unknown>, options?: { session?: unknown }): Promise<MongoDeleteResult>;
};

export type MongoSessionLike = {
  withTransaction<T>(run: () => Promise<T>): Promise<T | undefined>;
  endSession(): Promise<void>;
};

export type MongoClientLike = {
  startSession(): MongoSessionLike;
  db(name: string): {
    collection<TDoc>(name: string): MongoCollectionLike<TDoc>;
    command(command: Record<string, unknown>): Promise<unknown>;
    listCollections(): { toArray(): Promise<Array<{ name: string }>> };
  };
  close(): Promise<void>;
};

/** Mongo adapter 构造所需的注入面。 */
export type MongoCanvasRepositoryDeps = {
  client: MongoClientLike;
  database: string;
  now?: () => string;
  failWrites?: () => boolean;
};

/** 供测试的便捷类型：注入 driver 后拿到仓库。 */
export type MongoCanvasRepositoryFactory = (deps: MongoCanvasRepositoryDeps) => Promise<CanvasRepository>;
