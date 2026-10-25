import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types';
import { invocation } from '../shared/rpc.js';
export const TYPERT = {
  package: 'dsh-plugin-redmine', face: 'host', schemas: [], invocations: [invocation],
  model: { services: [{ key: 'redmine', exportName: 'RedmineHost', members: [{ kind: 'method', name: 'invoke', signature: 'invoke(request: RedmineRequest): Promise<RedmineResult>' }], types: [], tags: [] }], events: [], objects: [] },
} satisfies TypertContribution;
export default TYPERT;
