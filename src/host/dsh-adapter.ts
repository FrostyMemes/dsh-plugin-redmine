import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { SessionListValue, SessionRenameValue } from '@deepseek-ai/dsh-api-session-controller';
import type { DshAdapter, Workspace } from '../shared/contracts.js';

interface Entity { id: string; title: string; path: string }
export interface HostServices {
  workspaceRegistry: { list(): Entity[]; get(id: string): Entity | undefined; create(path: string): Promise<Entity>; archivedSessionIds: readonly string[] };
  getAgentPresets?: () => HostServices['agentPresets'];
  agentPresets?: {
    readonly defaultId: string;
    resolve(id?: string): Promise<{ id: string; broken?: string }>;
    compositionInventory(): Promise<{ id: string; rows: unknown[]; broken?: string }[]>;
    serviceFor(agent: { ctx: unknown }, name: string): unknown;
  };
  sessionController: {
    create(x: { workspaceId: string; sessionId: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>;
    resolveAgent(sessionId: string): Promise<{ agent: { ctx: unknown } } | { error: unknown }>;
    prompt(x: { sessionId: string; requestId: string; mode: 'followup'; content: { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<unknown>;
    list(x: {}, signal: AbortSignal): Promise<SessionListValue>;
    rename(x: { sessionId: string; title: string }): Promise<SessionRenameValue>;
  };
}

const PLAN_MODE_PACKAGE = '@deepseek-ai/dsh-plan-mode';

function rowContainsPlanMode(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const record = row as Record<string, unknown>;
  return record.moduleName === PLAN_MODE_PACKAGE && record.enabled === true && record.fiberState === 2;
}

export function createDshAdapter(services: HostServices): DshAdapter {
  const agentPresets = () => services.getAgentPresets?.() ?? services.agentPresets;
  async function existingSessions(sessionIds: string[]) {
    const archived = new Set(services.workspaceRegistry.archivedSessionIds);
    const requested = [...new Set(sessionIds)].filter(id => id && !archived.has(id));
    if (!requested.length) return [];
    const requestedSet = new Set(requested);
    const listed = await services.sessionController.list({}, new AbortController().signal);
    const available = new Set(listed.items.map(item => item.sessionId));
    return requested.filter(id => requestedSet.has(id) && available.has(id));
  }
  async function view(entity: Entity): Promise<Workspace> {
    let available = false;
    try { available = (await stat(entity.path)).isDirectory(); if (available) await access(entity.path, constants.R_OK | constants.X_OK); } catch { available = false; }
    return { id: entity.id, name: entity.title, path: entity.path, available };
  }
  return {
    async list() { return Promise.all(services.workspaceRegistry.list().map(view)); },
    async register(path) {
      if (!isAbsolute(path)) throw new Error('Укажите абсолютный путь к каталогу Host.');
      if (!(await stat(path)).isDirectory()) throw new Error('Выбранный путь не является каталогом.');
      await access(path, constants.R_OK | constants.X_OK);
      const canonical = await realpath(path);
      return view(await services.workspaceRegistry.create(canonical));
    },
    async validate(id) {
      const entity = services.workspaceRegistry.get(id);
      if (!entity) throw new Error('Workspace больше не зарегистрирован. Выберите его заново.');
      const workspace = await view(entity);
      if (!workspace.available) throw new Error('Каталог workspace отсутствует или недоступен.');
      return workspace;
    },
    async createSession(workspaceId, sessionId, agentPreset) {
      try {
        const created = await services.sessionController.create({ workspaceId, sessionId, ...(agentPreset ? { agentPreset } : {}) });
        if (agentPreset && created.agentPreset !== agentPreset) {
          throw Object.assign(new Error('DSH создал сессию с другим preset вместо проверенного. Промпт не отправлен.'), { sessionId: created.sessionId, planModePresetMismatch: true });
        }
        return created.sessionId;
      }
      catch (error) {
        const partial = error as { data?: { sessionId?: string }; details?: { sessionId?: string }; planModePresetMismatch?: boolean; sessionId?: string };
        if (partial.planModePresetMismatch) throw error;
        throw Object.assign(new Error('Не удалось создать или привязать сессию DSH.'), { sessionId: partial.data?.sessionId ?? partial.details?.sessionId });
      }
    },
    async planModePreset() {
      const registry = agentPresets();
      if (!registry) throw new Error('Режим планирования недоступен: в DSH не подключён реестр agent preset.');
      if (typeof registry.defaultId !== 'string' || !registry.defaultId || typeof registry.resolve !== 'function' || typeof registry.compositionInventory !== 'function' || typeof registry.serviceFor !== 'function' || typeof services.sessionController.resolveAgent !== 'function') {
        throw new Error('Режим планирования недоступен: DSH не предоставляет проверку активного agent preset.');
      }
      const presetId = registry.defaultId;
      try {
        const preset = await registry.resolve(presetId);
        if (preset.broken) throw new Error(preset.broken);
        const inventory = await registry.compositionInventory();
        const composition = inventory.find(item => item.id === presetId);
        if (!composition || composition.broken || !Array.isArray(composition.rows) || !composition.rows.some(rowContainsPlanMode)) {
          throw new Error(`preset "${presetId}" не содержит активный пакет ${PLAN_MODE_PACKAGE}`);
        }
        return presetId;
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : 'неизвестная ошибка';
        throw new Error(`Режим планирования недоступен: не удалось проверить preset DSH "${presetId}": ${detail}`);
      }
    },
    async enablePlanMode(sessionId) {
      const registry = agentPresets();
      if (!registry || typeof registry.serviceFor !== 'function' || typeof services.sessionController.resolveAgent !== 'function') {
        throw new Error('Не удалось включить режим планирования для созданной сессии DSH. Промпт не отправлен.');
      }
      let resolved: Awaited<ReturnType<HostServices['sessionController']['resolveAgent']>>;
      try { resolved = await services.sessionController.resolveAgent(sessionId); }
      catch { throw new Error('Не удалось получить Agent созданной сессии для включения режима планирования. Промпт не отправлен.'); }
      if ('error' in resolved) throw new Error('Не удалось получить Agent созданной сессии для включения режима планирования. Промпт не отправлен.');
      const agent = resolved.agent;
      let planMode: { set?: (agent: unknown, active: boolean) => unknown; get?: (agent: unknown) => { active?: boolean; pending?: boolean } } | undefined;
      try { planMode = registry.serviceFor(agent, 'planMode') as typeof planMode; }
      catch { throw new Error('Для созданной сессии недоступен сервис режима планирования. Промпт не отправлен.'); }
      if (typeof planMode?.set !== 'function' || typeof planMode.get !== 'function') {
        throw new Error('Для созданной сессии недоступен сервис режима планирования. Промпт не отправлен.');
      }
      try {
        planMode.set(agent, true);
        const state = planMode.get(agent);
        if (state.active !== true && state.pending !== true) throw new Error('режим остался выключен');
      } catch {
        throw new Error('Не удалось включить режим планирования для созданной сессии DSH. Промпт не отправлен.');
      }
    },
    async sendPrompt(sessionId, requestId, text) { await services.sessionController.prompt({ sessionId, requestId, mode: 'followup', content: [{ type: 'text', text }] }, new AbortController().signal); },
    async renameSession(sessionId, title) { await services.sessionController.rename({ sessionId, title }); },
    async sessionExists(sessionId) {
      return (await existingSessions([sessionId])).includes(sessionId);
    },
    existingSessions,
  };
}
