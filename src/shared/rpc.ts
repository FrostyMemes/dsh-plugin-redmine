import { z } from 'zod';
const empty = z.object({}).strict();
const ids = z.array(z.number().int().positive()).max(1000);
const identity = z.string().min(1).max(160);
const template = z.object({ id: identity, name: z.string().min(1).max(100), text: z.string().min(1).max(20000) }).strict();
const filters = z.object({ projects: ids, statuses: z.array(z.string().max(40)).max(100), trackers: ids, priorities: ids, categories: ids, search: z.string().max(300), sort: z.enum(['updated-desc','updated-asc','id-desc','subject-asc']), page: z.number().int().min(1).max(10000), pageSize: z.number().int().min(1).max(100) }).partial().strict();
export const inputSchemas = {
  state: empty,
  configure: z.object({ mockEnabled: z.boolean(), developerMode: z.boolean(), openCreatedSession: z.boolean(), launchInPlanMode: z.boolean(), baseUrl: z.string().max(2048), apiKey: z.string().max(4096), clearKey: z.boolean(), templates: z.array(template).min(1).max(20), defaultTemplateId: identity, mockScenario: z.enum(['normal','slow','empty','load-error','refresh-error','forbidden']) }).partial().strict(),
  check: empty,
  clearHealth: empty,
  list: z.object({ filters: filters.optional(), refresh: z.boolean().optional() }).strict(),
  workspaces: empty,
  selectWorkspace: z.object({ issueId: z.number().int().positive(), workspaceId: identity.optional(), path: z.string().min(1).max(32768).optional(), rememberProject: z.boolean() }).strict().refine(x => Boolean(x.workspaceId) !== Boolean(x.path), 'Choose a workspace or directory'),
  launch: z.object({ issueId: z.number().int().positive(), operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/), templateId: identity.optional(), confirmationToken: identity.optional(), existingSessionId: identity.optional() }).strict(),
  logs: z.object({ after: identity.optional() }).strict(),
  clientEvent: z.object({ level: z.enum(['debug','info','warning','error']), operation: z.enum(['state','configure','check','list','refresh','workspaces','selectWorkspace','launch','openSession','sessionAvailable','issueSessions','filter','search','sort','page']) }).strict(),
  runtimeError: z.object({ origin: z.enum(['browser','react']), message: z.string().max(2000), errorName: z.string().max(100).optional(), source: z.string().max(1000).optional(), line: z.number().int().nonnegative().optional(), column: z.number().int().nonnegative().optional(), stack: z.string().max(4000).optional() }).strict(),
  sessionAvailable: z.object({ sessionId: identity }).strict(),
  issueSessions: z.object({ issueId: z.number().int().positive(), expectedContextGeneration: z.number().int().nonnegative() }).strict(),
};
export const envelopeSchema = z.object({ action: z.enum(Object.keys(inputSchemas) as [keyof typeof inputSchemas, ...(keyof typeof inputSchemas)[]]), input: z.unknown() }).strict();
const requestCodec = { mode: 'strict' as const, typeSymbol: 'RedmineRequest', create: () => envelopeSchema };
const resultCodec = { mode: 'strict' as const, typeSymbol: 'RedmineResult', create: () => z.json() };
export const invocation = {
  id: 'dsh-plugin-redmine#redmine/invoke', service: 'redmine', namespace: 'redmine', method: 'invoke',
  invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: requestCodec }], result: resultCodec,
};
