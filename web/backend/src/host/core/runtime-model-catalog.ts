/** Imported catalog is display metadata, never an executable Provider or a login. */
import fs from 'node:fs';
import type {GenerationModelPolicyView} from '@woohaa3/contracts';
import type {GenerationModelPolicy} from '@woohaa3/application-service';

export function readRuntimeModelViews(file?: string): GenerationModelPolicyView[] {
  if (!file || !fs.existsSync(file)) return [];
  const records: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(records)) throw new Error('导入模型目录格式无效');
  return records.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('导入模型条目无效');
    const model = raw as Record<string, unknown>;
    if (typeof model.providerId !== 'string' || !model.providerId || typeof model.modelKey !== 'string' || !model.modelKey.startsWith(model.providerId + ':') || !['image','language','video','audio'].includes(String(model.modelType)) || typeof model.enabled !== 'boolean' || typeof model.isDefault !== 'boolean') throw new Error('导入模型条目无效');
    // Explicit fields prevent arbitrary local JSON fields reaching the public API.
    return {
      modelKey: model.modelKey, providerId: model.providerId,
      modelType: model.modelType as GenerationModelPolicyView['modelType'],
      enabled: model.enabled, isDefault: model.isDefault, executable: false,
      ...(typeof model.title === 'string' ? {title:model.title} : {}),
      ...(typeof model.extensionId === 'string' ? {extensionId:model.extensionId} : {}),
      ...(typeof model.order === 'number' ? {order:model.order} : {}),
      ...(typeof model.taskTimeoutMs === 'number' ? {taskTimeoutMs:model.taskTimeoutMs} : {}),
      ...(model.tombstone === true ? {tombstone:true} : {})
    };
  });
}

export function mergeRuntimeModelViews(
  live: GenerationModelPolicyView[], cached: readonly GenerationModelPolicyView[],
  providers: readonly {providerId:string;models:readonly unknown[];catalogRevision?:number;available?:boolean}[],
  snapshot: {initialized:boolean;models:readonly GenerationModelPolicy[]}
): GenerationModelPolicyView[] {
  const models=new Map(live.map(model=>[model.modelKey,model]));
  const discovered=new Set(providers.filter(provider=>provider.models.length>0 || ((provider.catalogRevision??0)>0 && provider.available!==false)).map(provider=>provider.providerId));
  const policies=new Map(snapshot.models.map(policy=>[policy.modelKey,policy]));
  for(const model of cached){
    if(discovered.has(model.providerId))continue;
    const policy=policies.get(model.modelKey);
    models.set(model.modelKey,{
      ...model,
      enabled:(policy?.tombstone ?? model.tombstone) ? false : policy?.enabled ?? (!snapshot.initialized && model.enabled),
      isDefault:policy?.isDefault ?? (!snapshot.initialized && model.isDefault),
      ...(policy?.order!==undefined?{order:policy.order}:{}),
      ...(policy?.taskTimeoutMs!==undefined?{taskTimeoutMs:policy.taskTimeoutMs}:{}),
      ...(policy?.interaction?{interaction:policy.interaction}:{}),
      executable:false
    });
  }
  return [...models.values()];
}
