import { migratePresentedParameters, validateAgainstSchema, type CanvasTaskCatalogModel } from "@woohaa3/contracts";
import { generationParameterError } from "@woohaa3/ui/assistant";
import { projectParameterDefaults, projectParameterFields } from "./parameter-projection.js";

export const mediaDraftTarget = (space: string, canvasId: string | null | undefined, nodeId: string | undefined) => JSON.stringify([space, canvasId, nodeId]);
export const mediaDraftPartition = (modelKey: string, sourceId: string) => JSON.stringify([modelKey, sourceId]);

/** References and prompt retain their own owner. Validate the entire parameter candidate before migration. */
export function switchMediaParameters(from: CanvasTaskCatalogModel | null, to: CanvasTaskCatalogModel, current: Record<string, unknown>, own?: Record<string, unknown>) {
  if (own && Object.keys(own).length) return { parameters: own, resetLabels: [] as string[] };
  const fields = projectParameterFields(to);
  const defaults = projectParameterDefaults(to);
  const migrated = from ? migratePresentedParameters(projectParameterFields(from), fields, current) : {};
  const candidate = { ...defaults, ...migrated };
  fields.forEach(f => Object.assign(candidate, f.requiresByValue?.[String(candidate[f.key] ?? "")]));
  const properties = Object.fromEntries(fields.map(f => [f.key, f.schema]));
  const schema = { ...to.inputSchema, properties, required: fields.filter(f => f.required && !f.hiddenWhen?.some(r => candidate[r.field] === r.equals)).map(f => f.key) };
  // Hidden values are neither migrated nor submitted. A missing required structural input blocks later submission.
  const visible = Object.fromEntries(Object.entries(candidate).filter(([key]) => !fields.find(f => f.key === key)?.hiddenWhen?.some(r => candidate[r.field] === r.equals)));
  const parameters = validateAgainstSchema(visible, schema).ok ? candidate : defaults;
  const resetLabels = from ? projectParameterFields(from).filter(f => current[f.key] !== undefined && current[f.key] !== f.defaultValue &&
    !fields.some(target => target.presentation?.semanticId && target.presentation.semanticId === f.presentation?.semanticId && parameters[target.key] === current[f.key])).map(f => f.label) : [];
  return { parameters, resetLabels };
}

/** Check editing states before default normalization; reject blank numbers and unsupported required values. */
export function mediaParameterEditingError(model: CanvasTaskCatalogModel, parameters: Record<string, unknown>): string {
  const effective = { ...projectParameterDefaults(model), ...parameters };
  return projectParameterFields(model).filter(f => !f.hiddenWhen?.some(r => effective[r.field] === r.equals))
    .map(f => generationParameterError(f, effective)).find(Boolean) ?? "";
}
export function visibleMediaParameters(model: CanvasTaskCatalogModel, parameters: Record<string, unknown>) {
  const hidden = new Set(projectParameterFields(model).filter(f => f.hiddenWhen?.some(r => parameters[r.field] === r.equals)).map(f => f.key));
  const properties = model.inputSchema.properties as Record<string, unknown> | undefined;
  return Object.fromEntries(Object.entries(parameters).filter(([key, value]) => value !== undefined && !hidden.has(key) &&
    (key === "model" || key === "serviceConnectionId" || !properties || key in properties)));
}
