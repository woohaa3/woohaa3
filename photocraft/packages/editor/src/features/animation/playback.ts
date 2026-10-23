/**
 * 时间轴播放会话（U77，design D1/D4）。
 *
 * 播放是**会话态**：只推进文档的播放位置（内核导航命令，不记历史），不产生内容修改、不写偏好。
 * 规则：
 * - 同一次播放只有一个 tick 在飞：新 tick 之前必须结束上一帧的导航，避免重复导航堆积；
 * - 每次导航带上请求序号与文档代际；切帧/切标签/关闭/停止后晚到的结果被丢弃，不写入新文档；
 * - 单帧导航失败立即停止播放并把原因交给调用方显示（不吞错、不无限重试）；
 * - 到达 `workEnd`（或时长末尾）后回卷到 `workStart`。
 */

export type PlaybackStep = {
  /** 目标帧号。 */
  frame: number;
  /** 请求序号（单调递增）。 */
  requestId: number;
  /** 文档代际；代际变了就丢弃结果。 */
  generation: number;
};

export type PlaybackRange = { fps: number; duration: number; current: number; workStart: number; workEnd: number };

export type PlaybackOptions = {
  /** 当前文档代际（切文档/关闭时变化）。 */
  generation: () => number;
  /** 时间轴范围；返回 null 表示没有时间轴。 */
  range: () => PlaybackRange | null;
  /** 定位一帧；返回错误原因表示应停止播放。 */
  navigate: (step: PlaybackStep) => { ok: true } | { ok: false; message: string };
  /** 播放状态变化（界面据此切换按钮与显示当前帧）。 */
  onState?: (playing: boolean, message: string | null) => void;
  /** 调度器与时钟可注入，便于测试。 */
  schedule?: (run: () => void, delayMs: number) => number;
  cancelSchedule?: (handle: number) => void;
};

export class TimelinePlayback {
  private readonly options: PlaybackOptions;
  private playing = false;
  private timer: number | null = null;
  private request = 0;
  private generation = 0;
  private lastMessage: string | null = null;

  constructor(options: PlaybackOptions) {
    this.options = options;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** 上一次失败原因（成功的一次导航清空它）。 */
  message(): string | null {
    return this.lastMessage;
  }

  /** 从当前帧开始循环播放。重复调用是幂等的（不会叠加两个循环）。 */
  play(): { ok: true } | { ok: false; message: string } {
    if (this.playing) return { ok: true };
    const range = this.options.range();
    if (!range) return { ok: false, message: "当前文档没有时间轴，请先建立时间轴" };
    if (!Number.isFinite(range.fps) || range.fps <= 0) return { ok: false, message: "时间轴帧率无效，无法播放" };
    if (range.duration <= 0) return { ok: false, message: "时间轴没有帧，无法播放" };
    this.playing = true;
    this.lastMessage = null;
    this.generation = this.options.generation();
    this.options.onState?.(true, null);
    this.schedule();
    return { ok: true };
  }

  /** 停止播放。幂等；停止后晚到的结果不会再导航。 */
  stop(): void {
    if (this.timer !== null) {
      (this.options.cancelSchedule ?? clearTimeout)(this.timer);
      this.timer = null;
    }
    if (!this.playing) return;
    this.playing = false;
    this.options.onState?.(false, this.lastMessage);
  }

  /** 代际变化（切文档/关闭）时停止并丢弃在飞结果。 */
  invalidate(): void {
    this.generation = this.options.generation();
    this.stop();
  }

  private schedule(): void {
    this.timer = (this.options.schedule ?? setTimeout)(() => this.tick(), this.delayMs());
  }

  private delayMs(): number {
    const range = this.options.range();
    const fps = range && Number.isFinite(range.fps) && range.fps > 0 ? range.fps : 30;
    // 单帧间隔最少 10ms：高帧率下也要让出事件循环，避免把主线程锁死。
    return Math.max(10, Math.round(1000 / Math.min(fps, 1000)));
  }

  private tick(): void {
    this.timer = null;
    if (!this.playing) return;
    const range = this.options.range();
    if (!range) {
      this.fail("时间轴已被删除，播放停止");
      return;
    }
    const generation = this.options.generation();
    if (generation !== this.generation) {
      // 文档已切换：静默停止，不把旧文档的帧号写到新文档。
      this.stop();
      return;
    }
    const step: PlaybackStep = { frame: nextFrame(range), requestId: ++this.request, generation };
    const result = this.options.navigate(step);
    if (!result.ok) {
      this.fail(result.message);
      return;
    }
    if (!this.playing) return;
    this.schedule();
  }

  private fail(message: string): void {
    this.lastMessage = message;
    this.stop();
  }
}

/**
 * 播放的下一帧。
 *
 * 工作区范围按「含首不含尾」解释（`workEnd` 是上界，与内核 `work_end` 的既有语义一致），
 * 因此末帧是 `workEnd - 1`；播放头在工作区外或已在末帧时回卷到起点。
 */
export function nextFrame(range: PlaybackRange): number {
  const last = Math.max(0, range.duration - 1);
  const start = Math.min(Math.max(0, range.workStart), last);
  const rawEnd = range.workEnd > range.workStart ? range.workEnd - 1 : last;
  const end = Math.min(Math.max(start, rawEnd), last);
  if (range.current < start || range.current >= end) return start;
  return range.current + 1;
}
