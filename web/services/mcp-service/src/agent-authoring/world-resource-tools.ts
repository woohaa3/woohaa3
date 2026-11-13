/** Resource-specific tools: strict operation branches, shared query semantics. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { WORLD_RESOURCE_TOOLS, SHARED_WORLD_VERSION, type WorldResourceEdit } from '@woohaa3/contracts';
import { structured, auditWrap, type AgentAuthoringToolDeps } from './tool-policy.js';
import { worldGrant, worldFailure, denied, point, groundAabb, rotation, projection, captureMode, aspect, animationBudget, motionConventions } from './world-tool-shared.js';

const id = z.string().min(1).max(512);
const title = z.string().max(200);
const areaTarget = z.strictObject({ areaId: id });
const modelTarget = z.strictObject({ instanceId: id });
const cameraTarget = z.strictObject({ cameraId: id });
const transformFields = { position: point, rotation, scale: z.number().finite().positive() };
const transform = z.strictObject(transformFields);
const settingsFields = { position: point, rotation: rotation.optional(), lookAt: point.optional(), projection, captureMode, aspect, boundInstanceId: id.nullable() };
const settings = z.strictObject(settingsFields).refine(value => !!value.rotation !== !!value.lookAt, '须提供 rotation 或 lookAt，且不能同时提供');
const settingsPatch = z.strictObject({ position: point.optional(), rotation: rotation.optional(), lookAt: point.optional(), projection: projection.optional(), captureMode: captureMode.optional(), aspect: aspect.optional(), boundInstanceId: id.nullable().optional() });
const mutation = { operationId: id };
const configPatch = z.strictObject({ duration: z.number().finite().positive().optional(), loop: z.boolean().optional() });
const edits = z.array(z.strictObject({ oldString: z.string().min(1), newString: z.string() })).max(128);
const annotations = { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false };
const outputSchema = z.looseObject({ ok: z.boolean() });

/** Flat object schema for model providers; operation-specific validation stays strict. */
function objectInput<T extends z.ZodDiscriminatedUnion>(union: T): z.ZodType<z.output<T>> {
  const options = union.options as z.ZodObject[];
  const keys = [...new Set(options.flatMap(option => Object.keys(option.shape)))];
  const shape: Record<string, z.ZodType> = {};
  for (const key of keys) {
    const fields = options.flatMap(option => option.shape[key] ? [option.shape[key] as z.ZodType] : []);
    let field: z.ZodType = fields.length === 1 ? fields[0]! : z.union(fields as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    if (fields.length < options.length) field = field.optional();
    shape[key] = field;
  }
  return z.strictObject(shape).superRefine((value, context) => {
    const parsed = union.safeParse(value);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }) as unknown as z.ZodType<z.output<T>>;
}

function scriptSchema(target: typeof areaTarget | typeof modelTarget, animation: boolean) {
  const config = animation ? { patch: configPatch.optional() } : {};
  const existing = { ...mutation, target, expectedVersion: id };
  return objectInput(z.discriminatedUnion('operation', [
    z.strictObject({ ...mutation, operation: z.literal('create'), target, expectedParentVersion: id, script: z.string().min(1), ...(animation ? { duration: z.number().finite().positive(), loop: z.boolean() } : {}) }),
    z.strictObject({ ...existing, operation: z.literal('replace'), script: z.string().min(1), ...config }),
    z.strictObject({ ...existing, operation: z.literal('append'), chunk: z.string().min(1), ...config }),
    z.strictObject({ ...existing, operation: z.literal('patch'), edits, ...config }),
    z.strictObject({ ...existing, operation: z.literal('delete') })
  ]));
}

export function registerWorldResourceTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  server.registerTool(WORLD_RESOURCE_TOOLS.read, {
    title: '查询世界资源',
    description: '授权内查询。get 读取单资源、脚本或 world_model_rig；list 仅枚举 scene_area/world_model/world_camera。脚本 lines 为闭区间，includeSource=false 只读元数据。版本来自真实回执；查询不授予写权限。',
    inputSchema: objectInput(z.discriminatedUnion('operation', [
      z.strictObject({ operation: z.literal('get'), resourceType: z.enum(['scene_area','world_model','world_camera','world_model_script','scene_animation_script','world_model_rig']), target: z.union([areaTarget, modelTarget, cameraTarget]), includeSource: z.boolean().optional(), lines: z.strictObject({ start: z.number().int().positive(), end: z.number().int().positive() }).optional() }),
      z.strictObject({ operation: z.literal('list'), resourceType: z.enum(['scene_area','world_model','world_camera']), areaId: id.optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() })
    ])), outputSchema, annotations: { ...annotations, readOnlyHint: true, destructiveHint: false }
  }, async input => {
    const bound = worldGrant(deps);
    if (!bound) return denied('本轮没有世界授权');
    const result = await bound.client.read({ canvasId: bound.canvasId, contextId: bound.world.contextId });
    if (!result.ok) return worldFailure(result);
    const view = result.view;
    const scope = view.scope.scope;
    const { animationScript: areaAnimation, ...areaSummary } = view.sceneArea ?? {};
    const scopedAreaId = scope.kind === 'scene-area' ? scope.areaId : null;
    if (input.operation === 'list' && input.areaId !== undefined && input.areaId !== scopedAreaId) return worldFailure({ code: 'outside-scope', message: '导演区不属于读取范围' });
    const versionOf = (type: string, ref: string) => view.resourceVersions?.[`${type}:${ref}`];
    const resources: Record<string, unknown>[] = input.resourceType === 'scene_area' ? scopedAreaId && view.sceneArea ? [{ ...areaSummary, areaId: scopedAreaId, bounds: view.bounds, hasAnimation: !!areaAnimation, version: view.sceneArea.resourceVersion }] : []
      : input.resourceType === 'world_camera' ? (view.sceneCameras ?? []).map(camera => ({ ...camera, cameraId: camera.settings.cameraId, version: versionOf('world_camera', camera.settings.cameraId) }))
      : input.resourceType === 'scene_animation_script' ? scopedAreaId && view.sceneArea?.animationScript ? [{ areaId: scopedAreaId, ...view.sceneArea.animationScript, version: versionOf('scene_animation_script', scopedAreaId) }] : []
      : (view.sceneModels ?? []).flatMap<Record<string, unknown>>(model => {
          if (input.resourceType === 'world_model_script') {
            const script = view.modelScripts?.[model.instanceId];
            return script ? [{ instanceId: model.instanceId, script, version: versionOf('world_model_script', model.instanceId) }] : [];
          }
          if (input.resourceType === 'world_model_rig') return model.animationRig ? [{ instanceId: model.instanceId, transform: model.transform, animationRig: model.animationRig, motionConventions, animationBudget: animationBudget(view.sceneArea?.animationScript), version: versionOf('world_model', model.instanceId) }] : [];
          const { animationRig, ...summary } = model;
          void animationRig;
          return [{ ...summary, hasScript: !!view.modelScripts?.[model.instanceId], version: versionOf('world_model', model.instanceId) }];
        });
    if (input.operation === 'list') {
      const start = input.cursor ? resources.findIndex(item => String(item.areaId ?? item.instanceId ?? item.cameraId) === input.cursor) + 1 : 0;
      if (input.cursor && start === 0) return worldFailure({ code: 'invalid-data', message: '分页 cursor 无效，请重新枚举' });
      const items = resources.slice(start, start + (input.limit ?? 20));
      const last = items.at(-1);
      return structured({ ok: true, items, nextCursor: start + items.length < resources.length && last ? String(last.areaId ?? last.instanceId ?? last.cameraId) : null }, '授权内资源列表');
    }
    const resource = resources.find(item => Object.entries(input.target).every(([key, value]) => item[key] === value));
    if (!resource) return worldFailure({ code: 'not-found', message: '授权读取范围内没有该资源' });
    if (typeof resource.script === 'string') {
      const lines = resource.script.split('\n');
      resource.totalLines = lines.length;
      resource.scriptLength = resource.script.length;
      if (input.includeSource === false) delete resource.script;
      else if (input.lines) {
        if (input.lines.end < input.lines.start) return worldFailure({ code: 'invalid-data', message: '行范围无效' });
        resource.script = lines.slice(input.lines.start - 1, input.lines.end).join('\n');
        resource.lines = input.lines;
      }
    }
    return structured({ ok: true, resource, version: resource.version }, '资源当前状态');
  });

  const register = (name: string, resourceType: WorldResourceEdit['resourceType'], inputSchema: z.ZodType, description: string) => {
    server.registerTool(name, { title: name, description, inputSchema, outputSchema, annotations }, async (raw: unknown) => {
      const bound = worldGrant(deps);
      if (!bound) return denied('本轮没有世界写授权');
      const edit = { ...(raw as object), resourceType } as WorldResourceEdit;
      if (!edit.operationId) return denied('缺少稳定 operationId');
      if (edit.transform) edit.transform = { ...edit.transform, version: SHARED_WORLD_VERSION };
      return auditWrap(deps, name, { canvasId: bound.canvasId, requestId: edit.operationId }, async () => {
        const result = await bound.client.write({ contextId: bound.world.contextId, operation: { kind: 'edit-resource', operationId: edit.operationId, edit } });
        return { result: result.ok ? structured(result as unknown as Record<string, unknown>, '资源编辑已提交') : worldFailure(result), ...(result.ok ? { revision: result.revision, duplicate: result.duplicate, noop: result.noop } : { code: result.code }) };
      });
    });
  };
  const update = (target: typeof areaTarget | typeof modelTarget | typeof cameraTarget, patch: z.ZodType) => z.strictObject({ ...mutation, operation: z.literal('update'), target, expectedVersion: id, patch });
  const remove = (target: typeof areaTarget | typeof modelTarget | typeof cameraTarget) => z.strictObject({ ...mutation, operation: z.literal('delete'), target, expectedVersion: id });
  // A director-area grant has no canvas lifecycle authority: do not advertise root create/delete.
  register(WORLD_RESOURCE_TOOLS.area, 'scene_area', update(areaTarget, z.strictObject({ title: title.optional(), bounds: groundAabb.optional(), moveBy: z.strictObject({ u: z.number().finite(), v: z.number().finite() }).optional(), rotateClockwise: z.literal(true).optional() })), '修改导演区名称或 patch.bounds；只改 bounds 不移动内容。patch.moveBy 整体平移，patch.rotateClockwise 整体顺时针旋转90度；三种空间操作互斥。当前授权不包含导演区创建/删除。成功后重读上下文。');
  register(WORLD_RESOURCE_TOOLS.model, 'world_model', objectInput(z.discriminatedUnion('operation', [
    z.strictObject({ ...mutation, operation: z.literal('create'), areaId: id, title: title.optional(), transform, initialScript: z.string().optional() }),
    update(modelTarget, z.strictObject({ title: title.optional(), transform: z.strictObject({ position: point.optional(), rotation: rotation.optional(), scale: z.number().finite().positive().optional() }).optional() })), remove(modelTarget)
  ])), '创建/局部修改/删除模型实例；省略 initialScript 创建骨架。模型脚本通过 edit_world_model_script 修改。transform 使用世界 u/v/h 米制。');
  register(WORLD_RESOURCE_TOOLS.camera, 'world_camera', deps.grant?.world?.scope.scope.kind === 'world-camera'
    ? update(cameraTarget, z.strictObject({ settings: settingsPatch }))
    : objectInput(z.discriminatedUnion('operation', [z.strictObject({ ...mutation, operation: z.literal('create'), areaId: id, title: title.optional(), settings }), update(cameraTarget, z.strictObject({ title: title.optional(), settings: settingsPatch.optional() })), remove(cameraTarget)])),
    '创建/局部修改/删除镜头。lookAt 为世界注视点，与 rotation 互斥；省略 position 使用现有机位。单镜头授权仅允许 update 构图。引用冲突须先处理引用。');
  register(WORLD_RESOURCE_TOOLS.modelScript, 'world_model_script', scriptSchema(modelTarget, false), '模型源码 create/replace/append/patch/delete。create 携带 expectedParentVersion，已有脚本操作携带 expectedVersion。patch 操作的顶层 edits 按顺序精确替换，每个 oldString 恰好命中一次；newString 为空删除局部内容。整个操作原子编译，失败原文不变；delete 保留空骨架。写前用 get_model_api 获取 scene.* API。');
  register(WORLD_RESOURCE_TOOLS.animation, 'scene_animation_script', scriptSchema(areaTarget, true), '导演区动画 create/replace/append/patch/delete，patch 使用与模型脚本相同的 edits；可用 patch.duration/loop 修改配置。先查询原动画，保留未要求改动的轨道。motion.instance/part/camera 声明运动，位置遵守 animationOrigin/animationQuarterTurns，旋转为角度 Y-X-Z，zoom>1 更广。关节/行走前读取 world_model_rig，真实 profile 不可伪造；写后用 sample_scene_animation 检查 warnings，数据采样不代表视觉验收。');
}
