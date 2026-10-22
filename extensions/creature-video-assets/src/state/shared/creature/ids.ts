/**
 * 阶段 06 原为「动作锚点」（为每个动作独立生成首尾帧图片），已废弃：
 * 自成一体的锚点图与站定图在姿态、位置、大小上对不齐，还常被画框截断。
 * 现在改为在阶段 07 内部用「行走视频的首尾帧」派生出其他动作的衔接帧，
 * 编号 06 留空以保持既有 stageId 不变。
 */
export const STAGE_IDS = [
  '01_brief',
  '02_identity_board',
  '03_direction_plan',
  '04_action_design',
  '05_direction_stills',
  '07_rgb_videos',
  '08_matting',
  '09_publish',
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export const DIRECTION_IDS = ['12_00', '1_30', '3_00', '4_30', '6_00', '7_30', '9_00', '10_30'] as const;
export type DirectionId = (typeof DIRECTION_IDS)[number];

/** 任务排序用的时钟顺序（从 6:00 开始），不改变方向语义。 */
export const GENERATION_ORDER = ['6_00', '7_30', '9_00', '10_30', '12_00', '1_30', '3_00', '4_30'] as const;

export const DEFAULT_SELECTED_DIRECTIONS: readonly DirectionId[] = GENERATION_ORDER;

export type DirectionTransform = 'hflip';
export type DirectionPolicyEntry =
  | { kind: 'master' }
  | { kind: 'mirror'; source: DirectionId; transform: DirectionTransform };

/** 生物头部在屏幕上指向的时钟语义：12:00 朝上，3:00 朝右，6:00 朝下，9:00 朝左。 */
export const MIRROR_POLICY: Readonly<Record<DirectionId, DirectionPolicyEntry>> = {
  '6_00': { kind: 'master' },
  '7_30': { kind: 'master' },
  '9_00': { kind: 'master' },
  '10_30': { kind: 'master' },
  '12_00': { kind: 'master' },
  '1_30': { kind: 'mirror', source: '10_30', transform: 'hflip' },
  '3_00': { kind: 'mirror', source: '9_00', transform: 'hflip' },
  '4_30': { kind: 'mirror', source: '7_30', transform: 'hflip' },
};

export const STAGE_STATUSES = [
  'not_started',
  'ready',
  'running',
  'self_check_failed',
  'awaiting_user_approval',
  'approved',
  'stale',
  'failed',
  'blocked',
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const REVIEW_GATE_IDS = ['stage-output', 'pilot', 'batch'] as const;
export type ReviewGateId = (typeof REVIEW_GATE_IDS)[number];

export const QA_STATUSES = ['pass', 'pass_with_warnings', 'fail', 'not_applicable'] as const;
export type QaStatus = (typeof QA_STATUSES)[number];

export const TARGET_KINDS = ['character', 'npc', 'prop'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const ASSET_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;
export const SAFE_SLUG_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

export const BRANCHES_FOR_STAGE: Readonly<Record<StageId, readonly StageId[]>> = {
  '01_brief': [],
  '02_identity_board': ['01_brief'],
  '03_direction_plan': ['01_brief', '02_identity_board'],
  '04_action_design': ['01_brief', '02_identity_board', '03_direction_plan'],
  '05_direction_stills': ['01_brief', '02_identity_board', '03_direction_plan'],
  '07_rgb_videos': ['04_action_design', '05_direction_stills'],
  '08_matting': ['07_rgb_videos'],
  '09_publish': [...STAGE_IDS.filter(stageId => stageId !== '09_publish')],
};

/** 身份板影响 05-09（主链之外的补充依赖）。 */
export const EXTRA_DEPENDENTS: Readonly<Record<StageId, readonly StageId[]>> = {
  '01_brief': [],
  '02_identity_board': ['05_direction_stills', '07_rgb_videos', '08_matting', '09_publish'],
  '03_direction_plan': ['04_action_design', '05_direction_stills', '07_rgb_videos', '08_matting', '09_publish'],
  '04_action_design': ['07_rgb_videos', '08_matting', '09_publish'],
  '05_direction_stills': ['07_rgb_videos', '08_matting', '09_publish'],
  '07_rgb_videos': ['08_matting', '09_publish'],
  '08_matting': ['09_publish'],
  '09_publish': [],
};

export function isStageId(value: string): value is StageId {
  return (STAGE_IDS as readonly string[]).includes(value);
}

export function isDirectionId(value: string): value is DirectionId {
  return (DIRECTION_IDS as readonly string[]).includes(value);
}
