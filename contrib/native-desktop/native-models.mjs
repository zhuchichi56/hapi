export function parseModelCatalog(tools) {
  const schema = tools?.find(tool => tool.name === 'create_thread')?.inputSchema?.properties?.model;
  const description = schema?.description ?? '';
  const models = typeof description === 'string' ? [...description.matchAll(/\b([a-z][a-z0-9.-]+)\s+\([^)]*supported reasoning efforts:\s*([^)]*)\)/g)].map(match => ({
    id: match[1], reasoningEfforts: match[2].split(',').map(value => value.trim()).filter(Boolean),
  })) : [];
  return { models: [...new Map(models.map(model => [model.id, model])).values()], supportsSelection: models.length > 0 };
}
