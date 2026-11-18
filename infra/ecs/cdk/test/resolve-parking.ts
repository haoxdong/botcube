import { Template } from 'aws-cdk-lib/assertions';
import type { Stack } from 'aws-cdk-lib';

export function parkingTemplate(stack: Stack, mode: boolean | 'parked' | 'egress' | 'credential' | 'live' = false, prepareOrigin = false): Template {
  const parked = typeof mode === 'boolean' ? mode : mode !== 'live';
  const conditions = { Parked: parked, Live: !parked, OriginInfrastructureEnabled: !parked || prepareOrigin, EgressEnabled: typeof mode === 'boolean' ? !mode : mode !== 'parked', CredentialEnabled: typeof mode === 'boolean' ? !mode : mode === 'credential' || mode === 'live' };
  const template = structuredClone(Template.fromStack(stack).toJSON());
  for (const section of ['Resources', 'Outputs']) {
    template[section] = Object.fromEntries(Object.entries(template[section] ?? {}).filter(([, resource]) => {
      const condition = (resource as { Condition?: string }).Condition;
      return condition === undefined || conditions[condition as keyof typeof conditions];
    }).map(([key, resource]) => {
      const { Condition: _, ...rest } = resource as Record<string, unknown>;
      return [key, rest];
    }));
  }
  const resolved = Object.fromEntries(Object.entries(template).map(([key, value]) => [key, resolveValue(value, conditions)]));
  const resources = resolved.Resources as Record<string, { DependsOn?: string[] }>;
  const known = new Set([...Object.keys(resources), ...Object.keys(template.Parameters ?? {})]);
  const expectKnown = (id: string) => { if (!known.has(id)) throw new Error(`Dangling CloudFormation reference ${id}, parked=${parked}`); };
  for (const resource of Object.values(resources)) {
    resource.DependsOn?.forEach(expectKnown);
    checkReferences(resource, expectKnown);
  }
  checkReferences(resolved.Outputs, expectKnown);
  return Template.fromJSON(resolved);
}

function resolveValue(value: unknown, conditions: Record<string, boolean>): unknown {
  if (Array.isArray(value)) return value.map(item => resolveValue(item, conditions));
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if ('Fn::If' in record) {
    const [condition, yes, no] = record['Fn::If'] as [string, unknown, unknown];
    if (!(condition in conditions)) return record;
    return resolveValue(conditions[condition] ? yes : no, conditions);
  }
  if ('Fn::Join' in record && Array.isArray(record['Fn::Join'])) {
    const [delimiter, parts] = record['Fn::Join'] as [string, unknown[]];
    if (delimiter === '') return { 'Fn::Join': ['', joinStrings(parts.map(part => resolveValue(part, conditions)))] };
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, resolveValue(item, conditions)])
    .filter(([, item]) => !(item && typeof item === 'object' && 'Ref' in item && item.Ref === 'AWS::NoValue')));
}

function joinStrings(parts: unknown[]) {
  const merged: unknown[] = [];
  for (const part of parts) {
    const value = typeof part === 'boolean' || typeof part === 'number' ? String(part) : part;
    if (typeof value === 'string' && typeof merged[merged.length - 1] === 'string') merged[merged.length - 1] += value;
    else merged.push(value);
  }
  return merged;
}

function checkReferences(value: unknown, expectKnown: (id: string) => void): void {
  if (!value || typeof value !== 'object') return;
  if ('Ref' in value && typeof value.Ref === 'string' && !value.Ref.startsWith('AWS::')) expectKnown(value.Ref);
  if ('Fn::GetAtt' in value && Array.isArray(value['Fn::GetAtt'])) expectKnown(value['Fn::GetAtt'][0]);
  Object.values(value).forEach(item => checkReferences(item, expectKnown));
}
