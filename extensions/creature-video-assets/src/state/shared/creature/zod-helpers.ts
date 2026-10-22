import { z } from 'zod';
import { DIRECTION_IDS, REVIEW_GATE_IDS, STAGE_IDS, STAGE_STATUSES, TARGET_KINDS } from './ids';

export const zStageId = z.enum(STAGE_IDS);
export const zDirectionId = z.enum(DIRECTION_IDS);
export const zReviewGateId = z.enum(REVIEW_GATE_IDS);
export const zStageStatus = z.enum(STAGE_STATUSES);
export const zTargetKind = z.enum(TARGET_KINDS);
