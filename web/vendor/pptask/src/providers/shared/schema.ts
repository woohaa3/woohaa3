export type ProviderSchemaEntry = {
  modelId: string;
  label: string;
  outputType: string;
  modality?: string;
  endpoint: { method: string; path: string };
  requestSchema: Record<string, any>;
  wireMetadata: Record<string, any>;
};

export function schemaDefaults(schema: Record<string, any>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (!property || typeof property !== 'object') continue;
    if ('default' in property) {
      result[name] = property.default;
      continue;
    }
    const propertySchema = property as Record<string, any>;
    if (propertySchema.type === 'object') {
      const nested = schemaDefaults(propertySchema);
      if (Object.keys(nested).length) result[name] = nested;
    }
  }
  return result;
}

export function flattenNestedSchema(
  schema: Record<string, any>,
  ignored: readonly (string | undefined)[],
  nestedField?: string,
): Record<string, unknown> {
  const ignoredFields = new Set(ignored.filter((value): value is string => Boolean(value)));
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (ignoredFields.has(name) || name === nestedField) continue;
    properties[name] = property;
    if (schema.required?.includes(name)) required.push(name);
  }
  if (nestedField) {
    const nested = schema.properties?.[nestedField];
    for (const [name, property] of Object.entries(nested?.properties ?? {})) {
      properties[name] = property;
      if (nested?.required?.includes(name)) required.push(name);
    }
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}
