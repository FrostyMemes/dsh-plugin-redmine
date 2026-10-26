import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { SessionListValue, SessionRenameValue } from '@deepseek-ai/dsh-api-session-controller';
import type { DshAdapter, Workspace } from '../shared/contracts.js';

interface Entity { id: string; title: string; path: string }
export interface HostServices {
  workspaceRegistry: { list(): Entity[]; get(id: string): Entity | undefined; create(path: string): Promise<Entity>; archivedSessionIds: readonly string[] };
  sessionController: {
    create(x: { workspaceId: string; sessionId: string }): Promise<{ sessionId: string }>;
    prompt(x: { sessionId: string; requestId: string; mode: 'followup'; content: { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<unknown>;
    list(x: {}, signal: AbortSignal): Promise<SessionListValue>;
    rename(x: { sessionId: string; title: string }): Promise<SessionRenameValue>;
  };
}

export function createDshAdapter(services: HostServices): DshAdapter {
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
    async createSession(workspaceId, sessionId) {
      try { return (await services.sessionController.create({ workspaceId, sessionId })).sessionId; }
      catch (error) {
        const partial = error as { data?: { sessionId?: string }; details?: { sessionId?: string } };
        throw Object.assign(new Error('Не удалось создать или привязать сессию DSH.'), { sessionId: partial.data?.sessionId ?? partial.details?.sessionId });
      }
    },
    async sendPrompt(sessionId, requestId, text) { await services.sessionController.prompt({ sessionId, requestId, mode: 'followup', content: [{ type: 'text', text }] }, new AbortController().signal); },
    async renameSession(sessionId, title) { await services.sessionController.rename({ sessionId, title }); },
    async sessionExists(sessionId) {
      if (services.workspaceRegistry.archivedSessionIds.includes(sessionId)) return false;
      return (await services.sessionController.list({}, new AbortController().signal)).items.some(item => item.sessionId === sessionId);
    },
  };
}
