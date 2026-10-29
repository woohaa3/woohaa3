/**
 * 镜头参考录制的 **dirty 集与触发策略**（纯逻辑）
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 8.3 / design D9）。
 *
 * 职责边界：本模块只决定「哪些镜头的哪一版视觉内容需要录制、什么时候允许开始」，不执行录制、
 * 不编码、不上传、不写画布。录制能力由任务 8.4 提供，版本缓存由 8.5 提供。
 *
 * 策略：
 * - **聚焦内只标脏**：当前聚焦的片场，其镜头即使内容变化也只留在 dirty 集，`drain` 不返回；
 * - **退出聚焦触发**：离开聚焦后，被压住的 dirty 镜头立即可被 `drain` 取走；
 * - **非聚焦权威更新 / 缺缓存恢复 / 下游请求补排**：非聚焦状态下 `observe`/`enqueue` 的镜头
 *   立即可被取走；
 * - **不因重命名、布局、缩放、hover 录制**：dirty 判定只用调用方传入的**视觉内容身份**
 *   （`shotReferenceContentIdentity` 已排除这些），本模块不自行读取画布；
 * - **不做聚焦编辑防抖**：内容一变即标脏，没有额外等待窗口。
 *
 * 纯类：不 import DOM、Zustand、Yjs 或任何业务解码器，可在 node 环境直接单测。
 */

/** 一次待录制任务：稳定的定位身份 + 视觉内容身份 + 录制 profile。 */
export type ShotReferenceRecordingJob = {
  canvasId: string;
  filmSetNodeId: string;
  clipId: string;
  contentIdentity: string;
  profileKey: string;
};

/** 单个镜头的内容观察结果；`contentIdentity` 为 `null` 表示非可录镜头（静态/缺失/非法）。 */
export type ShotReferenceClipObservation = {
  clipId: string;
  contentIdentity: string | null;
  profileKey: string;
};

/** 一个片场的观察结果；`focused` 表示该片场当前是否处于聚焦编辑。 */
export type ShotReferenceFilmSetObservation = {
  filmSetNodeId: string;
  focused: boolean;
  clips: readonly ShotReferenceClipObservation[];
};

/** 稳定 job key：画布 + 片场 + clipId。 */
export function shotReferenceJobKey(input: { canvasId: string; filmSetNodeId: string; clipId: string }): string {
  return [input.canvasId, input.filmSetNodeId, input.clipId].join("\u0000");
}

export class ShotReferenceRecordingQueue {
  /** 已确认 ready 的内容身份（key → identity）；由调用方在版本缓存就绪后回填。 */
  private readonly recorded = new Map<string, string>();
  /** 待录制任务（key → job）。 */
  private readonly queued = new Map<string, ShotReferenceRecordingJob>();
  /** 已交给执行方、尚未结算的 key，避免重复取走。 */
  private readonly inflight = new Set<string>();
  /** 当前聚焦的片场；其镜头只标脏、不取走。 */
  private focused: string | null = null;

  /**
   * 用**当前画布**的快照覆盖 dirty 集：逐个片场/镜头重算。
   *
   * 只增删调用方实际观察到的 job：内容身份与已记录一致则移除，不同或未记录则排队；非可录
   * 镜头（`contentIdentity === null`）移除其 job。传入的观察集合之外的旧 job 会被丢弃，
   * 因为画布快照就是权威。
   */
  observe(canvasId: string, filmSets: readonly ShotReferenceFilmSetObservation[]): void {
    const seen = new Set<string>();
    for (const filmSet of filmSets) {
      if (filmSet.focused) this.focused = filmSet.filmSetNodeId;
      for (const clip of filmSet.clips) {
        const key = shotReferenceJobKey({ canvasId, filmSetNodeId: filmSet.filmSetNodeId, clipId: clip.clipId });
        seen.add(key);
        if (clip.contentIdentity === null) {
          this.queued.delete(key);
          this.inflight.delete(key);
          continue;
        }
        if (this.recorded.get(key) === clip.contentIdentity) {
          this.queued.delete(key);
          continue;
        }
        const existing = this.queued.get(key);
        if (existing && existing.contentIdentity === clip.contentIdentity && existing.profileKey === clip.profileKey) {
          continue;
        }
        this.queued.set(key, {
          canvasId,
          filmSetNodeId: filmSet.filmSetNodeId,
          clipId: clip.clipId,
          contentIdentity: clip.contentIdentity,
          profileKey: clip.profileKey
        });
        // 内容已变化：旧的 in-flight 结果不再代表当前版本，允许重新排队取走。
        this.inflight.delete(key);
      }
    }
    for (const key of [...this.queued.keys()]) {
      if (!seen.has(key)) {
        this.queued.delete(key);
        this.inflight.delete(key);
      }
    }
  }

  /** 下游请求补排：把某一镜头当前版本加入 dirty 集（幂等）。 */
  enqueue(job: ShotReferenceRecordingJob): void {
    const key = shotReferenceJobKey(job);
    if (this.recorded.get(key) === job.contentIdentity) return;
    const existing = this.queued.get(key);
    if (existing && existing.contentIdentity === job.contentIdentity) return;
    this.queued.set(key, job);
    this.inflight.delete(key);
  }

  /** 聚焦切换（聚焦片场 id 或 `null`）；离开聚焦后需调用方再 `drain`。 */
  setFocused(filmSetNodeId: string | null): void {
    this.focused = filmSetNodeId;
  }

  /**
   * 取走**下一个**允许开始录制的 job；没有则返回 `null`。
   *
   * 聚焦片场的 job 被压住不返回（只标脏）；取走的 job 标记为 in-flight，直到 `complete`/`fail`
   * 结算。串行执行方每次只取一个，避免把未处理的 job 误标为 in-flight。
   */
  nextJob(): ShotReferenceRecordingJob | null {
    for (const [key, job] of [...this.queued.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (this.inflight.has(key)) continue;
      if (this.focused !== null && job.filmSetNodeId === this.focused) continue;
      this.inflight.add(key);
      return job;
    }
    return null;
  }

  /** 录制成功：记录该版本已 ready，并清除同版本 dirty。 */
  complete(job: ShotReferenceRecordingJob): void {
    const key = shotReferenceJobKey(job);
    // 先结算 in-flight：内容在录制期间变了也要放行，否则该 key 永远无法重录。
    this.inflight.delete(key);
    if (this.queued.get(key)?.contentIdentity !== job.contentIdentity) return;
    this.recorded.set(key, job.contentIdentity);
    if (this.queued.get(key)?.contentIdentity === job.contentIdentity) this.queued.delete(key);
  }

  /** 录制失败或取消：允许重试（job 仍留在 dirty 集）。 */
  fail(job: ShotReferenceRecordingJob): void {
    this.inflight.delete(shotReferenceJobKey(job));
  }

  /** 外部版本缓存已就绪（例如加载后恢复）：直接标记，不重新录制。 */
  markRecorded(job: { canvasId: string; filmSetNodeId: string; clipId: string; contentIdentity: string }): void {
    const key = shotReferenceJobKey(job);
    this.recorded.set(key, job.contentIdentity);
    if (this.queued.get(key)?.contentIdentity === job.contentIdentity) this.queued.delete(key);
    // **不**清 in-flight：录制成功后发布资产会让画布立刻回填缓存（正在录的就是这个 key），
    // 此时清掉会让活动投影误判「已不在录」并显示取消，而录制其实正在成功收尾。
    // in-flight 由 `complete` / `fail` 结算。
  }

  /** 某版本是否已 ready（已记录且不在 dirty/in-flight）。 */
  isRecorded(job: { canvasId: string; filmSetNodeId: string; clipId: string; contentIdentity: string }): boolean {
    const key = shotReferenceJobKey(job);
    return this.recorded.get(key) === job.contentIdentity && !this.queued.has(key);
  }

  /** 观察用快照（诊断/测试）：当前 dirty、in-flight 与焦点。 */
  snapshot(): {
    dirty: readonly ShotReferenceRecordingJob[];
    inflight: readonly string[];
    focused: string | null;
  } {
    return { dirty: [...this.queued.values()], inflight: [...this.inflight], focused: this.focused };
  }
}
