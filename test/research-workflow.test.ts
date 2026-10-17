import { expect, test } from 'bun:test';
import research from '../orc.workflows/research.ts';
import { buildPlan, validateWorkflowDef } from '../src/workflow.ts';

test('research requires text and binds its verified output to the researcher', () => {
  expect(() => research({})).toThrow('requires --prompt');
  expect(() => research({ prompt: '   ' })).toThrow('requires --prompt');
  const question = 'Compare providers for a coding agent';
  const def = research({ prompt: question });
  validateWorkflowDef(def);
  const [optimizer, researcher] = def.steps;
  expect(optimizer!.prompt).toContain(question);
  expect(optimizer!.prompt).toContain('Write the brief to optimized-query.txt');
  expect(optimizer!.verify).toEqual({ artifact: { name: 'optimized-query' } });
  expect(researcher!.inputs).toEqual([{
    name: 'query', fromStep: optimizer!.id,
    artifact: 'optimized-query', materializeAs: 'optimized-query.txt',
  }]);
  expect(researcher!.prompt).toContain('${inputs.query}');
  expect(researcher!.outputs![0]!.required).toBe(true);
  expect(buildPlan(def).steps[1]!.needs).toEqual([optimizer!.id]);
  expect(def.keepSessionsOnError).toBeUndefined();
});
