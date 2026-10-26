import React, { useEffect, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { Action, Commands, PluginApi } from '../shared/contracts.js';
import TYPERT_REMOTE from './remote.js';
import { RedminePanel, RedmineSettings } from './ui.js';
// CSS is embedded in the installed module, not fetched from a development server.
import css from './style.css';
import { installRuntimeDiagnostics, type RuntimeDiagnostic } from '../diagnostics/runtime.js';
import { DiagnosticsErrorBoundary } from '../diagnostics/DiagnosticsErrorBoundary.js';

export const inject = ['remote', 'slots', 'uiWorkspace'];
interface ClientContext {
  remote: { $mount(contribution: unknown): Promise<() => Promise<void>>; redmine: { invoke(request: unknown): Promise<any> } };
  slots: { inject(name: string, callback: () => unknown): unknown; register(options: Record<string, unknown>, component: React.ComponentType<any>): unknown };
  uiWorkspace: { pickDirectory(): Promise<string | null>; openSession(id: string): Promise<void> | void };
}
export function createClientApi(ctx: ClientContext): PluginApi {
  return {
    async call<K extends Action>(action: K, input: Commands[K]['input']): Promise<Commands[K]['output']> {
      const result = await ctx.remote.redmine.invoke({ action, input });
      if (!result.ok) throw new Error(`DSH: ${result.error?.code ?? 'ошибка соединения'}`);
      if (result.value.error) throw new Error(result.value.error);
      return result.value.value;
    },
    async pickDirectory() { return (await ctx.uiWorkspace.pickDirectory()) ?? undefined; },
    async openSession(id) { await ctx.uiWorkspace.openSession(id); },
  };
}
export function RedmineRoot({ api }: { api: PluginApi }) {
  const [settings, showSettings] = useState(false);
  const [version, bump] = useState(0);
  useEffect(() => {
    const open = () => showSettings(true);
    window.addEventListener('redmine:open-settings', open);
    return () => window.removeEventListener('redmine:open-settings', open);
  }, []);
  return <div className="rm-main-root">{settings ? <><div className="rm-back"><button className="rm-back-button" onClick={() => { showSettings(false); bump(x => x + 1); }}>← Мои задачи</button></div><RedmineSettings api={api}/></> : <RedminePanel key={version} api={api}/>}</div>;
}
export function apply(ctx: Context) {
  const client = ctx as unknown as ClientContext;
  const style = document.createElement('style'); style.dataset.redmine = 'true'; style.textContent = css; document.head.append(style);
  let unmount: (() => Promise<void>) | undefined;
  let fiber: ReturnType<Context['inject']> | undefined;
  let disposed = false;
  void client.remote.$mount(TYPERT_REMOTE).then(dispose => {
    unmount = dispose;
    if (disposed) { void dispose(); return; }
    fiber = ctx.inject(['remote.redmine'], ready => {
      const bound = ready as unknown as ClientContext;
      const api = createClientApi(bound);
      const report = (event: RuntimeDiagnostic) => { void api.call('runtimeError', event).catch(() => undefined); };
      ready.effect(() => installRuntimeDiagnostics(report));
      bound.slots.inject('main', () => bound.slots.register({ name: 'main', key: 'redmine' }, () => <DiagnosticsErrorBoundary report={report}><RedmineRoot api={api}/></DiagnosticsErrorBoundary>));
      bound.slots.inject('sidebar.panellist', () => bound.slots.register({ name: 'sidebar.panellist', id: 'redmine', order: 30, label: () => 'Redmine' }, () => <span aria-hidden="true">☷</span>));
      bound.slots.inject('plugins.bundle.config', () => bound.slots.register({ name: 'plugins.bundle.config', key: 'dsh-plugin-redmine' }, () => <DiagnosticsErrorBoundary report={report}><RedmineSettings api={api}/></DiagnosticsErrorBoundary>));
    });
  }).catch(() => { console.error('Redmine: не удалось подключить интерфейс к DSH.'); });
  ctx.effect(() => async () => { disposed = true; style.remove(); await fiber?.dispose(); await unmount?.(); });
}
