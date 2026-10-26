export type Level = 'debug' | 'info' | 'warning' | 'error';
export type Action = keyof Commands;
export interface Named { id: number; name: string }
export interface Category extends Named { projectId: number }
export interface Issue { id: number; subject: string; project: Named; status: Named & { closed?: boolean }; tracker?: Named; priority?: Named; category?: Named; assignedTo?: Named; updatedOn?: string; url: string }
export interface Workspace { id: string; name: string; path: string; available: boolean }
export interface Template { id: string; name: string; text: string }
export type MockScenario = 'normal' | 'slow' | 'empty' | 'load-error' | 'refresh-error' | 'forbidden';
export interface Settings { mockEnabled: boolean; developerMode: boolean; openCreatedSession: boolean; baseUrl: string; keyConfigured: boolean; templates: Template[]; defaultTemplateId: string; mockScenario: MockScenario }
export interface Filters { projects: number[]; statuses: string[]; trackers: number[]; priorities: number[]; categories: number[]; search: string; sort: 'updated-desc' | 'updated-asc' | 'id-desc' | 'subject-asc'; page: number; pageSize: number }
export interface Catalog { projects: Named[]; statuses: (Named & { closed?: boolean })[]; trackers: Named[]; priorities: Named[]; categories: Category[]; warnings: string[] }
export interface HealthStep { name: string; status: 'ok' | 'warning' | 'error' | 'skipped'; message: string; httpStatus?: number }
export interface Health { status: 'ok' | 'warning' | 'error'; checkedAt: string; mock: boolean; stale: boolean; user?: Named; steps: HealthStep[] }
export interface Launch { operationId: string; issueId: number; workspaceId: string; sessionId: string; requestId: string; sessionTitle?: string; titleApplied?: boolean; status: 'creating' | 'sending' | 'sent' | 'failed'; createdAt: string; error?: string }
export interface Row { issue: Issue; workspace?: Workspace; launches: Launch[] }
export interface ListResult { rows: Row[]; total: number; catalog: Catalog; filters: Filters; fetchedAt: string; incomplete: boolean; user: Named }
export interface LogEntry { id: string; time: string; level: Level; component: string; operation: string; message: string; fields: Record<string, string | number | boolean | null> }
export interface State { settings: Settings; filters: Filters; health?: Health }
export interface Commands {
  state: { input: {}; output: State };
  configure: { input: Partial<Omit<Settings, 'keyConfigured'>> & { apiKey?: string; clearKey?: boolean }; output: State };
  check: { input: {}; output: Health };
  list: { input: { filters?: Partial<Filters>; refresh?: boolean }; output: ListResult };
  workspaces: { input: {}; output: Workspace[] };
  selectWorkspace: { input: { issueId: number; workspaceId?: string; path?: string; rememberProject: boolean }; output: Workspace };
  launch: { input: { issueId: number; operationId: string; templateId?: string }; output: Launch };
  logs: { input: { after?: string }; output: LogEntry[] };
  clientEvent: { input: { level: Level; operation: string }; output: { accepted: boolean } };
  runtimeError: { input: { origin: 'browser' | 'react'; message: string; errorName?: string; source?: string; line?: number; column?: number; stack?: string }; output: { accepted: boolean } };
  sessionAvailable: { input: { sessionId: string }; output: { available: boolean } };
}
export interface PluginApi {
  call<K extends Action>(action: K, input: Commands[K]['input']): Promise<Commands[K]['output']>;
  pickDirectory(): Promise<string | undefined>;
  openSession(sessionId: string): Promise<void>;
}
export interface Store { get<T>(key: string, fallback: T): Promise<T>; set<T>(key: string, value: T): Promise<void> }
export interface CredentialStore { resolve(): Promise<string | undefined>; set(value: string): Promise<void>; clear(): Promise<void> }
export interface DshAdapter {
  list(): Promise<Workspace[]>;
  register(path: string): Promise<Workspace>;
  validate(id: string): Promise<Workspace>;
  createSession(workspaceId: string, sessionId: string): Promise<string>;
  sendPrompt(sessionId: string, requestId: string, text: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  sessionExists(sessionId: string): Promise<boolean>;
}
export const DEFAULT_FILTERS: Filters = { projects: [], statuses: ['open'], trackers: [], priorities: [], categories: [], search: '', sort: 'updated-desc', page: 1, pageSize: 25 };
