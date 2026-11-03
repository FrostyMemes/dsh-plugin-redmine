import { Service, type Context } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { PluginService } from '../core/service.js';
import { envelopeSchema, inputSchemas } from '../shared/rpc.js';
import type { Action, CredentialStore, Store } from '../shared/contracts.js';
import { createBuildDiagnosticsImporter } from '../diagnostics/build-importer.js';
import { sanitizeRuntimeText } from '../diagnostics/runtime.js';
import { createDshAdapter } from './dsh-adapter.js';
import type { HostServices } from './dsh-adapter.js';

const CREDENTIAL = credentialRef('DSH_REDMINE_API_KEY');
const DOMAIN = defineDomain({ name: 'redmine_plugin', version: 1, tables: { records: domainTable(z.object({ value: z.json() })) } });
export { createDshAdapter };

export class RedmineHost extends TypertRemoteService {
  static inject = ['storageDomain', 'credentials', 'workspaceRegistry', 'sessionController'];
  private service!: PluginService;
  private secrets!: CredentialStore;
  private importBuild = createBuildDiagnosticsImporter();
  private developmentDiagnosticsFile?: string;
  private runtimeEvents: number[] = [];
  constructor(ctx: Context, config: { developmentDiagnosticsFile?: string } = {}) {
    super(ctx, 'redmine');
    if (config.developmentDiagnosticsFile) {
      if (!isAbsolute(config.developmentDiagnosticsFile)) throw new Error('developmentDiagnosticsFile must be absolute');
      this.developmentDiagnosticsFile = config.developmentDiagnosticsFile;
    }
    ctx.logger.exporter({ levels: { default: 3 }, export: record => {
      if (!this.service || !/(?:^|[.:/])redmine(?:$|[.:/])|dsh-plugin-redmine/.test(record.name)) return;
      const error = record.args.find(value => value instanceof Error) as Error | undefined;
      const text = error?.message ?? record.args.filter(value => typeof value === 'string').slice(0, 3).join(' ');
      if (!text) return;
      const level = record.type === 'warn' ? 'warning' : record.type;
      void this.service.diagnostic(level, 'dsh-runtime', record.name, sanitizeRuntimeText(text), {
        ...(error ? { errorName: error.name, stack: sanitizeRuntimeText(error.stack ?? '', 3000) } : {}),
      }).catch(() => undefined);
    } });
  }
  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(DOMAIN);
    this.ctx.effect(() => () => domain.close());
    const table = domain.table('records');
    const store: Store = {
      async get(key, fallback) { const value = table.get(key)?.value; return value === undefined ? structuredClone(fallback) : structuredClone(value) as typeof fallback; },
      async set(key, value) { if (value === undefined) { if (table.get(key)) await table.delete(key); } else await table.put(key, { value: JSON.parse(JSON.stringify(value)) }); },
    };
    this.secrets = {
      resolve: async () => (await this.ctx.credentials.resolve(CREDENTIAL))?.value,
      set: async value => { await this.ctx.credentials.set(CREDENTIAL, value); },
      clear: async () => { await this.ctx.credentials.unset(CREDENTIAL); },
    };
    const hostContext = this.ctx as unknown as HostServices & { get(name: string): unknown };
    const dsh = createDshAdapter({
      workspaceRegistry: hostContext.workspaceRegistry,
      sessionController: hostContext.sessionController,
      getAgentPresets: () => hostContext.get('agentPresets') as HostServices['agentPresets'],
    });
    this.service = await PluginService.create({ store, credentials: this.secrets, dsh, logDirectory: '' });
  }
  @Remote
  async invoke(request: unknown): Promise<any> {
    if (principalOf(this.ctx.invocation) !== undefined) throw new Error('Доступ разрешён только владельцу DSH.');
    const envelope = envelopeSchema.safeParse(request);
    if (!envelope.success) return { error: 'Некорректная команда плагина.' };
    const action = envelope.data.action as Action;
    const parsed = inputSchemas[action].safeParse(envelope.data.input);
    if (!parsed.success) return { error: 'Некорректные параметры команды.' };
    try {
      if (action === 'runtimeError') {
        const event = inputSchemas.runtimeError.parse(parsed.data);
        this.runtimeEvents = this.runtimeEvents.filter(time => time > Date.now() - 30000);
        if (this.runtimeEvents.length >= 20) return { value: { accepted: false } };
        this.runtimeEvents.push(Date.now());
        const { origin, message, ...fields } = event;
        await this.service.diagnostic('error', origin, 'exception', sanitizeRuntimeText(message), Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Record<string, string | number>);
        return { value: { accepted: true } };
      }
      if (action === 'logs' && this.developmentDiagnosticsFile && (await this.service.call('state', {})).settings.developerMode) {
        await this.importBuild(this.developmentDiagnosticsFile, (level, component, operation, message, fields) => this.service.diagnostic(level, component, operation, message, fields));
      }
      const value = await this.service.call(action, parsed.data as never);
      return { value: JSON.parse(JSON.stringify(value)) };
    }
    catch (cause) {
      let message = cause instanceof Error ? cause.message : 'Ошибка выполнения команды.';
      const secret = await this.secrets.resolve().catch(() => undefined);
      if (secret) message = message.replaceAll(secret, '[скрыто]');
      message = message.replace(/(Bearer\s+|(?:api[-_ ]?key|token|password|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, '$1[скрыто]').slice(0, 500);
      await this.service.diagnostic('error', 'host', action, message, { errorName: cause instanceof Error ? cause.name : 'Error' });
      return { error: message };
    }
  }
}
export default RedmineHost;
