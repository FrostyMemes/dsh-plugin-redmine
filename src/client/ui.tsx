import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Filters, Health, Issue, Launch, ListResult, LogEntry, MockScenario, PluginApi, Row, Settings, State, Template, Workspace } from '../shared/contracts.js';
import { DEFAULT_FILTERS } from '../shared/contracts.js';
import { sanitizeRuntimeText } from '../diagnostics/runtime.js';

type PanelProps = { api: PluginApi };
const SCENARIOS: { id: MockScenario; label: string }[] = [
  { id: 'normal', label: 'Обычная работа' }, { id: 'slow', label: 'Медленный ответ' },
  { id: 'empty', label: 'Пустой список' }, { id: 'load-error', label: 'Ошибка загрузки' },
  { id: 'refresh-error', label: 'Ошибка обновления' }, { id: 'forbidden', label: 'Доступ запрещён' },
];
const SORTS: [Filters['sort'], string][] = [
  ['updated-desc', 'Сначала недавно обновлённые'], ['updated-asc', 'Сначала давно обновлённые'],
  ['id-desc', 'Сначала новые по номеру'], ['subject-asc', 'По названию'],
];
const fmtDate = (value?: string) => value ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const errText = (e: unknown) => e instanceof Error ? e.message : 'Не удалось выполнить операцию.';
const shortPath = (path: string) => path || 'Путь не указан';
const statusTone = (closed?: boolean) => closed === true ? 'closed' : closed === false ? 'open' : 'unknown';
const safeIssueUrl = (value: string) => { try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; } };
const HEALTH_LABELS = { ok: 'Успешно', warning: 'Предупреждение', error: 'Ошибка', skipped: 'Пропущено' } as const;
const expandLegacyStatuses = (value: string[], statuses: { id: number; closed?: boolean }[]) => {
  if (!statuses.length) return value;
  if (value.includes('*') || value.includes('all')) return [];
  const legacyGroups = value.filter(token => token === 'open' || token === 'closed');
  if (!legacyGroups.length || statuses.some(status => status.closed === undefined)) return value;
  const ids = value.filter(token => token !== 'open' && token !== 'closed');
  for (const group of legacyGroups) {
    const closed = group === 'closed';
    const matching = statuses.filter(status => status.closed === closed);
    ids.push(...(matching.length ? matching.map(status => String(status.id)) : [group]));
  }
  return [...new Set(ids)];
};
const newTemplateId = (templates: Template[]) => {
  let id = '';
  do { id = `template-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  while (templates.some(template => template.id === id));
  return id;
};
const sanitizeLog = (log: LogEntry): LogEntry => ({
  ...log,
  component: sanitizeRuntimeText(log.component, 96),
  operation: sanitizeRuntimeText(log.operation, 96),
  message: sanitizeRuntimeText(log.message, 2_048),
  fields: Object.fromEntries(Object.entries(log.fields).map(([key, value]) => [
    sanitizeRuntimeText(key, 64),
    /api[_ -]?key|authorization|password|secret|token|cookie/i.test(key) ? '[скрыто]' : typeof value === 'string' ? sanitizeRuntimeText(value, 2_048) : value,
  ])),
});

export function RedminePanel({ api }: PanelProps) {
  const [remote, setRemote] = useState<State>();
  const [result, setResult] = useState<ListResult>();
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS });
  const [busy, setBusy] = useState(true);
  const [stateReady, setStateReady] = useState(false);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [workspaceIssue, setWorkspaceIssue] = useState<Issue>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceChoice, setWorkspaceChoice] = useState('');
  const [manualPath, setManualPath] = useState('');
  const [rememberProject, setRememberProject] = useState(true);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [launchBusy, setLaunchBusy] = useState<number | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [launchTemplateId, setLaunchTemplateId] = useState('');
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [scenarioError, setScenarioError] = useState('');
  const seq = useRef(0);
  const consumedRefresh = useRef(0);
  const firstLoad = useRef(true);
  const scenarioSaveActive = useRef(false);
  const remoteSnapshot = useRef<State>();
  const workspaceDialog = useRef<HTMLDialogElement>(null);
  const filterKey = JSON.stringify(filters);

  const acceptState = useCallback((saved: State) => {
    const previous = remoteSnapshot.current;
    const sourceChanged = !!previous && (
      previous.settings.mockEnabled !== saved.settings.mockEnabled ||
      previous.settings.baseUrl !== saved.settings.baseUrl ||
      previous.settings.keyConfigured !== saved.settings.keyConfigured
    );
    const scenarioChanged = !!previous && previous.settings.mockScenario !== saved.settings.mockScenario;
    remoteSnapshot.current = saved;
    setRemote(saved);
    if (sourceChanged || scenarioChanged) {
      if (sourceChanged) {
        setResult(undefined);
        setFilters(saved.filters ?? { ...DEFAULT_FILTERS });
      }
      setBusy(true);
      setRefreshSeq(current => current + 1);
    }
  }, []);
  const closeLogs = useCallback(() => setLogOpen(false), []);

  const clientEvent = useCallback((level: 'info' | 'warning' | 'error', operation: string) => {
    void api.call('clientEvent', { level, operation }).catch(() => undefined);
  }, [api]);

  useEffect(() => {
    let alive = true;
    void api.call('state', {}).then(s => { if (alive) { acceptState(s); setFilters(s.filters ?? { ...DEFAULT_FILTERS }); setLaunchTemplateId(s.settings.defaultTemplateId); } })
      .catch(e => { if (alive) { setError(errText(e)); clientEvent('error', 'state'); } })
      .finally(() => { if (alive) setStateReady(true); });
    return () => { alive = false; };
  }, [api, clientEvent, acceptState]);

  useEffect(() => {
    let alive = true;
    const refreshState = () => {
      if (document.visibilityState === 'hidden') return;
      void api.call('state', {}).then(saved => { if (alive) acceptState(saved); }).catch(() => undefined);
    };
    window.addEventListener('focus', refreshState);
    document.addEventListener('visibilitychange', refreshState);
    return () => {
      alive = false;
      window.removeEventListener('focus', refreshState);
      document.removeEventListener('visibilitychange', refreshState);
    };
  }, [api, acceptState]);

  useEffect(() => {
    if (!stateReady) return;
    const request = ++seq.current;
    let alive = true;
    const forceRefresh = refreshSeq > consumedRefresh.current;
    consumedRefresh.current = refreshSeq;
    setBusy(true);
    setError('');
    void api.call('list', { filters: JSON.parse(filterKey) as Filters, refresh: forceRefresh }).then(data => {
      if (!alive || request !== seq.current) return;
      setResult(data);
      const acceptedFilters = { ...data.filters, statuses: expandLegacyStatuses(data.filters.statuses, data.catalog.statuses) };
      if (JSON.stringify(acceptedFilters) !== filterKey) setFilters(current => JSON.stringify(current) === filterKey ? acceptedFilters : current);
      setRemote(prev => prev ? { ...prev, filters: data.filters } : prev);
      firstLoad.current = false;
      if (data.incomplete) setNotice('Показаны доступные данные. Часть справочников или результатов недоступна.');
      else setNotice('');
    }).catch(e => {
      if (!alive || request !== seq.current) return;
      setError(errText(e));
      clientEvent('error', firstLoad.current ? 'list' : 'refresh');
    }).finally(() => { if (alive && request === seq.current) setBusy(false); });
    return () => { alive = false; };
  }, [api, stateReady, filterKey, refreshSeq, clientEvent]);

  useEffect(() => {
    const dialog = workspaceDialog.current;
    if (!workspaceIssue || !dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('select, input, button')?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, [!!workspaceIssue]);
  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K], resetPage = true) => setFilters(current => ({ ...current, [key]: value, ...(resetPage ? { page: 1 } : {}) }));
  const catalog = result?.catalog;
  const pages = Math.max(1, Math.ceil((result?.total ?? 0) / (filters.pageSize || 25)));

  const openWorkspace = async (issue: Issue) => {
    setWorkspaceIssue(issue); setManualPath(''); setWorkspaceChoice(''); setError('');
    try { const list = await api.call('workspaces', {}); setWorkspaces(list); }
    catch (e) { setWorkspaces([]); setError(`Не удалось получить список workspace: ${errText(e)}`); }
  };
  const chooseDirectory = async () => {
    try { const path = await api.pickDirectory(); if (path) { setManualPath(path); setWorkspaceChoice(''); } }
    catch (e) { setError(`Не удалось открыть выбор каталога: ${errText(e)}`); }
  };
  const saveWorkspace = async () => {
    if (!workspaceIssue || (!workspaceChoice && !manualPath.trim())) return;
    setWorkspaceBusy(true); setError('');
    try {
      const selected = await api.call('selectWorkspace', {
        issueId: workspaceIssue.id, ...(workspaceChoice ? { workspaceId: workspaceChoice } : { path: manualPath.trim() }), rememberProject,
      });
      setResult(prev => prev ? { ...prev, rows: prev.rows.map(row => row.issue.id === workspaceIssue.id ? { ...row, workspace: selected } : row) } : prev);
      setRefreshSeq(n => n + 1);
      setWorkspaceIssue(undefined); setNotice('Workspace выбран для задачи.');
    } catch (e) { setError(errText(e)); clientEvent('error', 'selectWorkspace'); }
    finally { setWorkspaceBusy(false); }
  };

  const saveScenario = async (scenario: MockScenario) => {
    if (!remote?.settings.developerMode || !remote.settings.mockEnabled || scenarioSaveActive.current) return;
    scenarioSaveActive.current = true;
    setScenarioBusy(true); setScenarioError(''); setError('');
    try {
      const saved = await api.call('configure', { mockScenario: scenario });
      acceptState(saved);
    } catch (e) {
      const message = errText(e);
      setScenarioError(message); clientEvent('error', 'configure');
    } finally {
      scenarioSaveActive.current = false;
      setScenarioBusy(false);
    }
  };

  const launch = async (row: Row, retryOperationId?: string) => {
    if (!row.workspace?.available || launchBusy !== null) return;
    const operationId = retryOperationId ?? (globalThis.crypto?.randomUUID?.() ?? `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    setLaunchBusy(row.issue.id); setError(''); setNotice('');
    try {
      const templateId = remote?.settings.templates.some(template => template.id === launchTemplateId) ? launchTemplateId : remote?.settings.defaultTemplateId;
      const started = await api.call('launch', { issueId: row.issue.id, operationId, ...(templateId ? { templateId } : {}) });
      setResult(current => current ? ({ ...current, rows: current.rows.map(r => r.issue.id === row.issue.id ? { ...r, launches: [started, ...r.launches.filter(x => x.operationId !== started.operationId)] } : r) }) : current);
      if (started.status === 'failed') { setError(started.error || 'Не удалось запустить сессию. Повторите попытку.'); clientEvent('error', 'launch'); return; }
      setNotice(started.status === 'sent' ? 'Промпт отправлен в новую сессию.' : 'Сессия создана. Проверяем доступность…');
      await openSession(started);
    } catch (e) {
      setError(`${errText(e)} Повторите отправку из истории запусков, если операция была сохранена.`); clientEvent('error', 'launch');
      try { setResult(await api.call('list', { filters })); } catch { /* the existing issue list remains visible */ }
    }
    finally { setLaunchBusy(null); }
  };
  const openSession = async (launchItem: Launch) => {
    try {
      const available = await api.call('sessionAvailable', { sessionId: launchItem.sessionId });
      if (!available.available) { setNotice('Сессия пока недоступна для открытия. Её можно проверить повторно из истории запусков.'); return false; }
      await api.openSession(launchItem.sessionId); return true;
    } catch { setNotice('Сессия создана, но её не удалось открыть. Попробуйте открыть её позже.'); return false; }
  };

  return <main className="redmine-app" aria-label="Redmine: мои задачи">
    <header className="rm-header">
      <div className="rm-heading"><span className="rm-mark" aria-hidden="true">▤</span><div><h1>Redmine</h1><p>Мои задачи{result?.user?.name ? ` · ${result.user.name}` : ''}</p></div>
        {remote?.settings.mockEnabled && <span className="rm-badge">Демо</span>}</div>
      <div className="rm-header-actions">
        <button className="rm-icon-button" onClick={() => setRefreshSeq(n => n + 1)} disabled={busy} title="Обновить список задач" aria-label="Обновить список задач"><span className={busy ? 'rm-spin' : ''}>↻</span></button>
        <button className="rm-icon-button" onClick={() => { window.dispatchEvent(new Event('redmine:open-settings')); }} aria-label="Настройки Redmine" title="Настройки">⚙</button>
      </div>
    </header>
    <div className="rm-toolbar"><span className="rm-readonly">Только чтение</span><span>{result ? `Обновлено ${fmtDate(result.fetchedAt)}` : remote?.settings.baseUrl || 'Подключение не настроено'}</span>
      {remote?.settings.developerMode && remote.settings.mockEnabled && <label className="rm-scenario-control"><span>Сценарий демо</span><select value={remote.settings.mockScenario} disabled={scenarioBusy} onChange={event => void saveScenario(event.target.value as MockScenario)}>{SCENARIOS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>{scenarioBusy && <span role="status">Сохранение…</span>}</label>}
      {remote?.settings.developerMode && <button className="rm-link-button" onClick={() => setLogOpen(true)}>Открыть логи</button>}
    </div>
    {scenarioError && <div className="rm-error" role="alert">Не удалось сохранить сценарий: {scenarioError}<button onClick={() => setScenarioError('')} aria-label="Скрыть ошибку">×</button></div>}
    {notice && <div className="rm-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Скрыть">×</button></div>}
    {error && <div className="rm-error" role="alert" tabIndex={-1}>{error}<button onClick={() => setError('')} aria-label="Скрыть ошибку">×</button></div>}
    {result?.incomplete && <p className="rm-warning">Данные могут быть неполными. Проверьте предупреждения ниже.</p>}
    {catalog?.warnings?.length ? <details className="rm-warnings"><summary>Ограничения справочников ({catalog.warnings.length})</summary><ul>{catalog.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details> : null}
    <section className="rm-filters" aria-label="Фильтры задач">
      <label className="rm-search"><span className="sr-only">Поиск по номеру или названию</span><span aria-hidden="true">⌕</span><input value={filters.search} onChange={e => updateFilter('search', e.target.value)} placeholder="Поиск по № или названию" /></label>
      <MultiSelect label="Проекты" options={catalog?.projects ?? []} selected={filters.projects} onChange={v => updateFilter('projects', v)} searchable allLabel="Все доступные проекты" />
      <StatusSelect statuses={catalog?.statuses ?? []} value={filters.statuses} onChange={v => updateFilter('statuses', v)} />
      <MultiSelect label="Типы" options={catalog?.trackers ?? []} selected={filters.trackers} onChange={v => updateFilter('trackers', v)} />
      <MultiSelect label="Приоритеты" options={catalog?.priorities ?? []} selected={filters.priorities} onChange={v => updateFilter('priorities', v)} />
      <MultiSelect label="Категории" options={(catalog?.categories ?? []).map(category => ({ ...category, name: `${category.name} · ${catalog?.projects.find(project => project.id === category.projectId)?.name ?? `#${category.projectId}`}` }))} selected={filters.categories} onChange={v => updateFilter('categories', v)} />
      <label className="rm-select-label"><span>Сортировка</span><select value={filters.sort} onChange={e => updateFilter('sort', e.target.value as Filters['sort'])}>{SORTS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
      <button className="rm-reset" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>Сбросить</button>
    </section>
    <div className="rm-list-heading"><div><strong>Задачи</strong><span>{busy ? 'Загрузка…' : result ? `${result.total} найдено` : ''}</span></div><label>Шаблон запуска <select aria-label="Шаблон запуска" value={launchTemplateId || remote?.settings.defaultTemplateId || ''} onChange={e => setLaunchTemplateId(e.target.value)} disabled={!remote?.settings.templates.length}>{remote?.settings.templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label><label>На странице <select value={filters.pageSize} onChange={e => updateFilter('pageSize', Number(e.target.value))}><option>25</option><option>50</option><option>100</option></select></label></div>
    {busy && !result && <div className="rm-skeleton" aria-label="Загружаются задачи"><i/><i/><i/></div>}
    {!busy && result && !result.rows.length && <div className="rm-empty"><span aria-hidden="true">⌕</span><strong>Задачи не найдены</strong><p>Измените фильтры или обновите список.</p><button className="rm-secondary" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>Сбросить фильтры</button></div>}
    {result && <div className={busy || error ? 'rm-issue-list rm-stale' : 'rm-issue-list'} aria-busy={busy}>
      {(busy || error) && <div className="rm-stale-label">{error ? 'Показаны ранее загруженные данные' : 'Обновление; показаны предыдущие данные'}</div>}
      {result.rows.map(row => <IssueCard key={row.issue.id} row={row} busy={launchBusy === row.issue.id} globalLaunchBusy={launchBusy !== null} canLaunch={!!row.workspace?.available} onWorkspace={() => void openWorkspace(row.issue)} onLaunch={operationId => void launch(row, operationId)} onOpenSession={openSession} />)}
    </div>}
    {result && <nav className="rm-pagination" aria-label="Страницы задач"><span>Страница {filters.page} из {pages}</span><div><button className="rm-secondary" disabled={filters.page <= 1 || busy} onClick={() => updateFilter('page', filters.page - 1, false)}>Назад</button><button className="rm-secondary" disabled={filters.page >= pages || busy} onClick={() => updateFilter('page', filters.page + 1, false)}>Далее</button></div></nav>}
    {workspaceIssue && <dialog ref={workspaceDialog} className="rm-dialog" aria-modal="true" aria-labelledby="workspace-title" onCancel={e => { e.preventDefault(); setWorkspaceIssue(undefined); }}><div className="rm-dialog-card"><div className="rm-dialog-header"><div><h2 id="workspace-title">Выбрать workspace</h2><p>Задача #{workspaceIssue.id} · {workspaceIssue.project.name}</p></div><button className="rm-icon-button" onClick={() => setWorkspaceIssue(undefined)} aria-label="Закрыть">×</button></div>
      {error && <div className="rm-error" role="alert">{error}</div>}
      <label className="rm-select-label"><span>Проект DSH</span><select value={workspaceChoice} onChange={e => { setWorkspaceChoice(e.target.value); setManualPath(''); }}><option value="">Выберите зарегистрированный workspace</option>{workspaces.map(w => <option key={w.id} value={w.id} disabled={!w.available}>{w.name} — {w.path}{w.available ? '' : ' (недоступен)'}</option>)}</select></label>
      <div className="rm-or">или выберите существующий каталог</div><div className="rm-path-picker"><input value={manualPath} onChange={e => { setManualPath(e.target.value); setWorkspaceChoice(''); }} placeholder="Абсолютный путь к каталогу" aria-label="Абсолютный путь к каталогу"/><button className="rm-secondary" onClick={() => void chooseDirectory()}>Обзор…</button></div>
      <label className="rm-checkbox"><input type="checkbox" checked={rememberProject} onChange={e => setRememberProject(e.target.checked)}/><span>Запомнить для проекта Redmine</span></label>
      <p className="rm-dialog-hint">Выберите проект DSH или существующую папку. Новая папка здесь не создаётся.</p>
      <div className="rm-dialog-actions"><button className="rm-secondary" onClick={() => setWorkspaceIssue(undefined)}>Отмена</button><button className="rm-primary" disabled={workspaceBusy || (!workspaceChoice && !manualPath.trim())} onClick={() => void saveWorkspace()}>{workspaceBusy ? 'Проверка…' : 'Выбрать workspace'}</button></div>
    </div></dialog>}
    <DiagnosticsLogDialog api={api} open={logOpen} enabled={!!remote?.settings.developerMode} onState={acceptState} onClose={closeLogs} />
  </main>;
}

function IssueCard({ row, busy, globalLaunchBusy, canLaunch, onWorkspace, onLaunch, onOpenSession }: { row: Row; busy: boolean; globalLaunchBusy: boolean; canLaunch: boolean; onWorkspace: () => void; onLaunch: (operationId?: string) => void; onOpenSession: (launch: Launch) => unknown }) {
  const { issue } = row;
  const issueUrl = safeIssueUrl(issue.url);
  return <article className="rm-issue-card"><div className="rm-issue-main">{issueUrl ? <a className="rm-issue-id" href={issueUrl} target="_blank" rel="noreferrer" title={`Открыть задачу #${issue.id} в Redmine`}>#{issue.id}</a> : <span className="rm-issue-id">#{issue.id}</span>}<h2 title={issue.subject}>{issue.subject}</h2></div>
    <div className="rm-issue-meta">
      <span className={`rm-status ${statusTone(issue.status.closed)}`}>{issue.status.name}</span>
      {issue.tracker && <span>{issue.tracker.name}</span>}{issue.priority && <span>{issue.priority.name}</span>}
      <span>{issue.category?.name ?? 'Без категории'}</span><span className="rm-project" title={issue.project.name}>{issue.project.name}</span><span>Обновлена {fmtDate(issue.updatedOn)}</span>
    </div>
    <div className="rm-issue-bottom"><div className={row.workspace?.available ? 'rm-workspace' : 'rm-workspace missing'}><span aria-hidden="true">▰</span><span title={row.workspace?.path}>{row.workspace ? `${row.workspace.name} · ${shortPath(row.workspace.path)}` : 'Workspace не выбран'}</span></div>
      <div className="rm-card-actions">{issueUrl ? <a className="rm-subtle-link" href={issueUrl} target="_blank" rel="noreferrer">В Redmine ↗</a> : <span className="rm-subtle-link" aria-label="Ссылка недоступна">Ссылка недоступна</span>}<button className="rm-secondary" onClick={onWorkspace}>{row.workspace ? 'Изменить workspace' : 'Выбрать workspace'}</button><button className="rm-primary" disabled={!canLaunch || busy} title={!canLaunch ? 'Сначала выберите доступный workspace' : undefined} onClick={() => onLaunch()}>{busy ? 'Запуск…' : 'В работу'}</button></div>
    </div>
    {!!row.launches.length && <div className="rm-launch-history"><span>Сессии</span>{row.launches.map(item => {
      const retryable = item.status === 'failed' || item.status === 'sending' || item.status === 'creating';
      const sameWorkspace = row.workspace?.id === item.workspaceId;
      return <span className="rm-launch-item" key={item.operationId}><span className={`rm-launch-state ${item.status}`}>{item.status === 'sent' ? 'Отправлено' : item.status === 'failed' ? 'Ошибка' : 'Создаётся'}</span><time>{fmtDate(item.createdAt)}</time>{item.error && <span className="rm-launch-error">{item.error}</span>}{retryable && <><button className="rm-secondary" disabled={globalLaunchBusy || !canLaunch || !sameWorkspace} title={!sameWorkspace ? 'Выберите workspace, использованный в исходной попытке' : !canLaunch ? 'Исходный workspace недоступен' : undefined} onClick={() => onLaunch(item.operationId)}>Повторить отправку</button>{!sameWorkspace && <span className="rm-launch-error" role="status">Для повтора выберите workspace, использованный в этой попытке.</span>}</>}<button className="rm-link-button" onClick={() => void onOpenSession(item)}>Открыть сессию</button></span>;
    })}</div>}
  </article>;
}

function DiagnosticsLogDialog({ api, open, enabled, onState, onClose }: { api: PluginApi; open: boolean; enabled: boolean; onState: (state: State) => void; onClose: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logLevel, setLogLevel] = useState('all');
  const [logSearch, setLogSearch] = useState('');
  const [logError, setLogError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const cursor = useRef<string>();
  const pullActive = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    if (!open || !enabled || !element) return;
    if (!element.open) element.showModal();
    element.querySelector<HTMLElement>('button, input, select')?.focus();
    return () => { if (element.open) element.close(); };
  }, [open, enabled]);

  useEffect(() => {
    if (!open || !enabled) return;
    let alive = true;
    const pull = async () => {
      if (pullActive.current) return;
      pullActive.current = true;
      try {
        const current = await api.call('state', {});
        if (!alive) return;
        onState(current);
        if (!current.settings.developerMode) { onClose(); return; }
        const batch = await api.call('logs', { after: cursor.current });
        if (alive && batch.length) {
          const safe = batch.map(sanitizeLog);
          cursor.current = safe[safe.length - 1].id;
          setLogs(previous => [...previous, ...safe.filter(item => !previous.some(old => old.id === item.id))].slice(-500));
        }
        if (alive) setLogError('');
      } catch (e) { if (alive) setLogError(errText(e)); }
      finally { pullActive.current = false; }
    };
    void pull();
    const timer = window.setInterval(pull, 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [api, open, enabled, onState, onClose]);

  const visibleLogs = useMemo(() => logs.filter(log =>
    (logLevel === 'all' || log.level === logLevel) &&
    (!logSearch || `${log.component} ${log.operation} ${log.message} ${JSON.stringify(log.fields)}`.toLocaleLowerCase().includes(logSearch.toLocaleLowerCase())),
  ), [logs, logLevel, logSearch]);

  const downloadLogs = async () => {
    try {
      const all = (await api.call('logs', {})).map(sanitizeLog);
      const safe = all.filter(log =>
        (logLevel === 'all' || log.level === logLevel) &&
        (!logSearch || `${log.component} ${log.operation} ${log.message} ${JSON.stringify(log.fields)}`.toLocaleLowerCase().includes(logSearch.toLocaleLowerCase())),
      );
      const blob = new Blob([JSON.stringify(safe, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'redmine-diagnostics.json'; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setLogError(`Не удалось подготовить журнал: ${errText(e)}`); }
  };

  if (!open || !enabled) return null;
  return <dialog ref={dialog} className="rm-dialog rm-log-dialog" aria-modal="true" aria-labelledby="logs-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="rm-dialog-card"><div className="rm-dialog-header"><div><h2 id="logs-title">Диагностика Redmine</h2><p>Обновление записей каждые 2 секунды, пока окно открыто</p></div><button className="rm-icon-button" onClick={onClose} aria-label="Закрыть">×</button></div>
      {logError && <p className="rm-warning" role="status">{logError}</p>}
      <div className="rm-log-controls"><label><span className="sr-only">Уровень</span><select value={logLevel} onChange={event => setLogLevel(event.target.value)}><option value="all">Все уровни</option><option value="debug">Отладка</option><option value="info">Информация</option><option value="warning">Предупреждение</option><option value="error">Ошибка</option></select></label><input value={logSearch} onChange={event => setLogSearch(event.target.value)} placeholder="Поиск по журналу" aria-label="Поиск по журналу"/><button className="rm-secondary" onClick={() => void downloadLogs()}>Скачать JSON</button></div>
      <div className="rm-log-list">{visibleLogs.length ? visibleLogs.slice(-200).reverse().map(log => <details className="rm-log-entry" key={log.id}><summary><time>{fmtDate(log.time)}</time><span className={`rm-level ${log.level}`}>{log.level}</span><strong>{log.operation}</strong><span>{log.message}</span></summary><dl>{Object.entries(log.fields).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{String(value ?? '—')}</dd></React.Fragment>)}</dl></details>) : <div className="rm-empty">Записей пока нет.</div>}</div>
    </div>
  </dialog>;
}

function MultiSelect<T extends number | string>({ label, options, selected, onChange, searchable = false, allLabel, hidden = false, allSelected, selectionLabel, emptyHint }: { label: string; options: { id: T; name: string }[]; selected: T[]; onChange: (value: T[]) => void; searchable?: boolean; allLabel?: string; hidden?: boolean; allSelected?: boolean; selectionLabel?: string; emptyHint?: string }) {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(''); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', outside); return () => document.removeEventListener('mousedown', outside); }, [open]);
  if (hidden) return null;
  const shown = options.filter(o => !query || o.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const labelText = selectionLabel ?? (!selected.length ? (allLabel ?? 'Все') : selected.length === 1 ? options.find(x => x.id === selected[0])?.name ?? String(selected[0]) : `${selected.length} выбрано`);
  return <div className="rm-multi" ref={ref}><span className="rm-filter-caption">{label}</span><button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>{labelText}<span aria-hidden="true">⌄</span></button>{open && <div className="rm-multi-menu" role="group" aria-label={label}>{searchable && <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Найти проект" aria-label={`Поиск: ${label}`}/>}<label className="rm-option"><input type="checkbox" checked={allSelected ?? !selected.length} onChange={() => onChange([])}/><span>{allLabel ?? 'Все'}</span></label>{shown.map(o => <label className="rm-option" key={o.id}><input type="checkbox" checked={selected.includes(o.id)} onChange={e => onChange(e.target.checked ? [...selected, o.id] : selected.filter(id => id !== o.id))}/><span>{o.name}</span></label>)}{emptyHint ? <p className="rm-multi-empty">{emptyHint}</p> : !shown.length && <p className="rm-multi-empty">Ничего не найдено</p>}</div>}</div>;
}
function StatusSelect({ statuses, value, onChange }: { statuses: { id: number; name: string; closed?: boolean }[]; value: string[]; onChange: (value: string[]) => void }) {
  const allSelected = value.length === 0 || value.includes('*') || value.includes('all');
  const expanded = expandLegacyStatuses(value, statuses);
  const selected = expanded.filter(id => statuses.some(status => String(status.id) === id));
  const legacyGroups = expanded.filter(token => token === 'open' || token === 'closed');
  const unresolvedLegacy = legacyGroups.length > 0;
  const legacyNames = legacyGroups.map(token => token === 'open' ? 'Все открытые' : 'Все закрытые');
  const unknownIds = expanded.filter(token => token !== 'open' && token !== 'closed' && token !== '*' && token !== 'all' && !statuses.some(status => String(status.id) === token));
  const closureFlagsKnown = statuses.length > 0 && statuses.every(status => status.closed !== undefined);
  const emptyLegacyGroup = unresolvedLegacy && closureFlagsKnown;
  const selectionLabel = allSelected ? 'Все статусы' : unresolvedLegacy
    ? `${[...new Set(legacyNames)].join(' и ')}${emptyLegacyGroup ? ' (0 в справочнике)' : ' · фильтр сохранён'}`
    : selected.length === 1 ? statuses.find(status => String(status.id) === selected[0])?.name ?? `#${selected[0]}`
      : selected.length > 1 ? `${selected.length} выбрано`
        : unknownIds.length ? `${unknownIds.map(id => `#${id}`).join(', ')} · список недоступен`
          : value.length ? `${value.length} выбрано` : 'Все статусы';
  const emptyHint = unresolvedLegacy
    ? emptyLegacyGroup
      ? `Для сохранённого фильтра ${[...new Set(legacyNames)].join(' и ').toLocaleLowerCase('ru-RU')} нет соответствующих статусов в справочнике.`
      : `${[...new Set(legacyNames)].join(' и ')} — сохранённый фильтр; состав конкретных статусов пока нельзя определить.`
    : unknownIds.length ? `Сохранённые ID статусов (${unknownIds.map(id => `#${id}`).join(', ')}) отсутствуют в доступном справочнике.`
    : statuses.length ? undefined : 'Справочник статусов недоступен.';
  return <MultiSelect label="Статусы" options={statuses.map(status => ({ id: String(status.id), name: status.name }))} selected={selected} onChange={onChange} allLabel="Все статусы" allSelected={allSelected} selectionLabel={selectionLabel} emptyHint={emptyHint}/>;
}
function HealthResults({ health }: { health: Health }) {
  return <div className="rm-health-results">
    <p><strong>{health.mock ? 'Результат демо-проверки' : 'Состояние подключения'}: {HEALTH_LABELS[health.status]}</strong> · {fmtDate(health.checkedAt)}{health.stale ? ' · данные устарели' : ''}{health.user ? ` · ${health.user.name}` : ''}</p>
    {health.mock && <p className="rm-hint">Проверка выполнена в демо-режиме; соединение с Redmine не проверялось.</p>}
    {health.steps.map((step, index) => <div className={`rm-health-row health-${step.status}`} key={`${step.name}-${index}`}><strong>{HEALTH_LABELS[step.status]} · {step.name}</strong><span>{step.message}{step.httpStatus ? ` · HTTP ${step.httpStatus}` : ''}</span></div>)}
  </div>;
}

export function RedmineSettings({ api }: PanelProps) {
  const [state, setState] = useState<State>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [modeSaving, setModeSaving] = useState<'mockEnabled' | 'developerMode' | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [modeError, setModeError] = useState('');
  const [modeMessage, setModeMessage] = useState('');
  const [templateError, setTemplateError] = useState('');
  const [templateMessage, setTemplateMessage] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [mockEnabled, setMockEnabled] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [defaultTemplateId, setDefaultTemplateId] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [templateText, setTemplateText] = useState('');
  const [templateIsDefault, setTemplateIsDefault] = useState(true);
  const [health, setHealth] = useState<Health>();
  const soleTemplate = templates.length === 1 ? templates[0] : undefined;
  const onlyExistingDefaultTarget = !!soleTemplate && templateName.trim() === soleTemplate.name.trim();

  useEffect(() => {
    let alive = true;
    void api.call('state', {}).then(saved => {
      if (!alive) return;
      setState(saved); setBaseUrl(saved.settings.baseUrl); setMockEnabled(saved.settings.mockEnabled);
      setDeveloperMode(saved.settings.developerMode);
      setTemplates(saved.settings.templates); setDefaultTemplateId(saved.settings.defaultTemplateId); setHealth(saved.health);
      const selected = saved.settings.templates.find(template => template.id === saved.settings.defaultTemplateId) ?? saved.settings.templates[0];
      setSelectedTemplateId(selected?.id ?? ''); setTemplateName(selected?.name ?? ''); setTemplateText(selected?.text ?? '');
      setTemplateIsDefault(!!selected && selected.id === saved.settings.defaultTemplateId);
    }).catch(e => alive && setConnectionError(errText(e))).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [api]);

  const save = async (patch: Partial<Omit<Settings, 'keyConfigured'>> & { apiKey?: string; clearKey?: boolean }) => {
    if (checking || modeSaving || saving) return;
    setSaving(true); setConnectionError(''); setConnectionMessage('');
    try {
      const saved = await api.call('configure', patch);
      setState(saved); setHealth(saved.health);
      if (patch.baseUrl !== undefined) setBaseUrl(saved.settings.baseUrl);
      if (patch.apiKey !== undefined || patch.clearKey === true) { setApiKey(''); setClearKey(false); }
      setConnectionMessage('Настройки подключения сохранены');
    } catch (e) { setConnectionError(errText(e)); }
    finally { setSaving(false); }
  };

  const saveMode = async (field: 'mockEnabled' | 'developerMode', value: boolean) => {
    if (!state || saving || checking || modeSaving) return;
    setModeSaving(field); setModeError(''); setModeMessage('');
    try {
      const saved = field === 'mockEnabled'
        ? await api.call('configure', { mockEnabled: value })
        : await api.call('configure', { developerMode: value });
      setState(saved); setHealth(saved.health);
      setMockEnabled(saved.settings.mockEnabled); setDeveloperMode(saved.settings.developerMode);
      setModeMessage('Режим сохранён');
    } catch (e) {
      setMockEnabled(state.settings.mockEnabled); setDeveloperMode(state.settings.developerMode);
      setModeError(errText(e));
    } finally { setModeSaving(null); }
  };

  const markHealthStale = () => setHealth(current => current ? { ...current, stale: true } : current);
  const check = async () => {
    if (!state || saving || modeSaving || checking) return;
    setChecking(true); setConnectionError(''); setConnectionMessage('');
    try {
      const checked = await api.call('check', {});
      setHealth(checked); setState(current => current ? { ...current, health: checked } : current);
    } catch (e) { setConnectionError(errText(e)); }
    finally { setChecking(false); }
  };

  const clearTemplateFeedback = () => { setTemplateError(''); setTemplateMessage(''); };
  const selectTemplate = (id: string) => {
    const selected = templates.find(template => template.id === id);
    if (!selected) return;
    setSelectedTemplateId(selected.id); setTemplateName(selected.name); setTemplateText(selected.text);
    setTemplateIsDefault(defaultTemplateId === selected.id); clearTemplateFeedback();
  };
  const setTemplateDefault = (checked: boolean) => {
    clearTemplateFeedback();
    if (checked) {
      setTemplateIsDefault(true);
      return;
    }
    if (onlyExistingDefaultTarget) return;
    setTemplateIsDefault(false);
  };
  const deleteSelectedTemplate = async () => {
    if (settingsBusy || templates.length <= 1 || !selectedTemplateId) return;
    clearTemplateFeedback();
    const rest = templates.filter(template => template.id !== selectedTemplateId);
    const nextDefaultId = defaultTemplateId === selectedTemplateId || !rest.some(template => template.id === defaultTemplateId) ? rest[0].id : defaultTemplateId;
    setSaving(true);
    try {
      const saved = await api.call('configure', { templates: rest, defaultTemplateId: nextDefaultId });
      setState(saved); setHealth(saved.health); setTemplates(saved.settings.templates); setDefaultTemplateId(saved.settings.defaultTemplateId);
      const nextSelected = saved.settings.templates.find(template => template.id === saved.settings.defaultTemplateId) ?? saved.settings.templates[0];
      setSelectedTemplateId(nextSelected?.id ?? ''); setTemplateName(nextSelected?.name ?? ''); setTemplateText(nextSelected?.text ?? '');
      setTemplateIsDefault(!!nextSelected && nextSelected.id === saved.settings.defaultTemplateId);
      setTemplateMessage('Шаблон удалён');
    } catch (e) { setTemplateError(errText(e)); }
    finally { setSaving(false); }
  };
  const saveTemplate = async () => {
    const name = templateName.trim();
    if (!name) { setTemplateError('Введите название шаблона.'); setTemplateMessage(''); return; }
    if (!templateText.trim()) { setTemplateError('Введите текст промпта шаблона.'); setTemplateMessage(''); return; }
    if (settingsBusy) return;
    const selectedMatchesName = templates.find(template => template.id === selectedTemplateId && template.name.trim() === name);
    const target = selectedMatchesName ?? templates.find(template => template.name.trim() === name);
    const targetId = target?.id ?? newTemplateId(templates);
    const savedTemplate = { id: targetId, name, text: templateText };
    const nextTemplates = target
      ? templates.map(template => template.id === targetId ? savedTemplate : template)
      : [...templates, savedTemplate];
    const fallbackDefault = nextTemplates.find(template => template.id !== targetId)?.id ?? targetId;
    const nextDefaultId = templateIsDefault
      ? targetId
      : defaultTemplateId === targetId
        ? fallbackDefault
        : defaultTemplateId;

    setSaving(true); setTemplateError(''); setTemplateMessage('');
    try {
      const saved = await api.call('configure', { templates: nextTemplates, defaultTemplateId: nextDefaultId });
      setState(saved); setHealth(saved.health); setTemplates(saved.settings.templates); setDefaultTemplateId(saved.settings.defaultTemplateId);
      const selected = saved.settings.templates.find(template => template.id === targetId) ?? saved.settings.templates.find(template => template.id === saved.settings.defaultTemplateId) ?? saved.settings.templates[0];
      setSelectedTemplateId(selected?.id ?? ''); setTemplateName(selected?.name ?? ''); setTemplateText(selected?.text ?? '');
      setTemplateIsDefault(!!selected && selected.id === saved.settings.defaultTemplateId);
      setTemplateMessage('Шаблон сохранён');
    } catch (e) { setTemplateError(errText(e)); }
    finally { setSaving(false); }
  };

  const normalizedUrl = (value: string) => {
    try { return new URL(value.trim()).toString().replace(/\/$/, ''); }
    catch { return value.trim(); }
  };
  const connectionDraftChanged = !state || normalizedUrl(baseUrl) !== normalizedUrl(state.settings.baseUrl) || !!apiKey || clearKey;
  const settingsBusy = saving || checking || modeSaving !== null;

  if (loading) return <section className="redmine-app rm-settings"><div className="rm-skeleton"><i/><i/></div></section>;
  return <section className="redmine-app rm-settings" aria-labelledby="settings-title">
    <header className="rm-settings-head"><div><h1 id="settings-title">Настройки Redmine</h1><p>Подключение, режимы и шаблоны запуска.</p></div></header>
    {connectionMessage && <div className="rm-notice" role="status">{connectionMessage}</div>}{connectionError && <div className="rm-error" role="alert" tabIndex={-1}>{connectionError}</div>}
    <section className="rm-settings-section"><h2>Подключение</h2>
      <label className="rm-field"><span>URL Redmine</span><input type="url" value={baseUrl} onChange={event => { setBaseUrl(event.target.value); setConnectionError(''); setConnectionMessage(''); markHealthStale(); }} placeholder="https://redmine.example.org" autoComplete="url"/></label>
      <label className="rm-field"><span>Персональный API-ключ {state?.settings.keyConfigured && <small>Ключ сохранён</small>}</span><input type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setClearKey(false); setConnectionError(''); setConnectionMessage(''); markHealthStale(); }} placeholder={state?.settings.keyConfigured ? 'Оставьте пустым, чтобы сохранить текущий' : 'Введите API-ключ'} autoComplete="new-password"/></label>
      {state?.settings.keyConfigured && <label className="rm-checkbox"><input type="checkbox" checked={clearKey} onChange={event => { setClearKey(event.target.checked); setApiKey(''); setConnectionError(''); setConnectionMessage(''); markHealthStale(); }}/><span>Удалить сохранённый ключ</span></label>}
      <div className="rm-inline-actions"><button className="rm-secondary" disabled={settingsBusy || connectionDraftChanged} onClick={() => void check()}>{checking ? 'Проверка…' : 'Проверить подключение'}</button><button className="rm-primary" disabled={settingsBusy} onClick={() => void save({ baseUrl, ...(apiKey ? { apiKey } : {}), ...(clearKey ? { clearKey: true } : {}) })}>{saving ? 'Сохранение…' : 'Сохранить подключение'}</button></div>
      {connectionDraftChanged && <p className="rm-hint" role="status">Сохраните подключение перед проверкой.</p>}
      {health ? <HealthResults health={health}/> : <p className="rm-hint">Проверка ещё не запускалась.</p>}
    </section>
    {modeMessage && <div className="rm-notice" role="status">{modeMessage}</div>}{modeError && <div className="rm-error" role="alert" tabIndex={-1}>{modeError}</div>}
    <section className="rm-settings-section"><h2>Режимы разработки</h2>
      <p className="rm-hint">Журнал диагностики доступен при включённом режиме разработчика для демо- и реального подключения.</p>
      <label className="rm-checkbox"><input type="checkbox" checked={mockEnabled} disabled={settingsBusy} onChange={event => { setModeError(''); setModeMessage(''); setMockEnabled(event.target.checked); void saveMode('mockEnabled', event.target.checked); }}/><span>Использовать демонстрационные данные</span></label>
      <label className="rm-checkbox"><input type="checkbox" checked={developerMode} disabled={settingsBusy} onChange={event => { setModeError(''); setModeMessage(''); setDeveloperMode(event.target.checked); void saveMode('developerMode', event.target.checked); }}/><span>Режим разработчика и журнал диагностики</span></label>
      {modeSaving && <p className="rm-hint" role="status">Сохранение режима…</p>}
    </section>
    {templateMessage && <div className="rm-notice" role="status">{templateMessage}</div>}{templateError && <div className="rm-error" role="alert" tabIndex={-1}>{templateError}</div>}
    <section className="rm-settings-section"><h2>Шаблоны запуска</h2>
      <p className="rm-hint">Промпт будет отправлен в новую сессию. Текст задачи и комментарии панель не загружает.</p>
      <p className="rm-hint">Доступные поля: {['{{issue.id}}', '{{issue.url}}', '{{issue.subject}}', '{{project.id}}', '{{project.name}}', '{{status}}', '{{tracker}}', '{{priority}}', '{{workspace.path}}'].map((value, index) => <React.Fragment key={value}>{index > 0 ? ', ' : ''}<code>{value}</code></React.Fragment>)}.</p>
      <article className="rm-template">
        <div className="rm-template-title"><label className="rm-field"><span>Шаблон</span><select value={selectedTemplateId} disabled={settingsBusy || !templates.length} onChange={event => selectTemplate(event.target.value)}>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label></div>
        <label className="rm-field"><span>Название шаблона</span><input value={templateName} disabled={settingsBusy} onChange={event => { const name = event.target.value; setTemplateName(name); if (soleTemplate && name.trim() === soleTemplate.name.trim()) setTemplateIsDefault(true); clearTemplateFeedback(); }}/></label>
        <label className="rm-checkbox"><input type="checkbox" checked={templateIsDefault} disabled={settingsBusy || onlyExistingDefaultTarget} onChange={event => setTemplateDefault(event.target.checked)}/><span>Шаблон по умолчанию</span></label>
        {onlyExistingDefaultTarget && <p className="rm-hint">Единственный сохранённый шаблон должен оставаться шаблоном по умолчанию.</p>}
        {soleTemplate && !onlyExistingDefaultTarget && !templateIsDefault && <p className="rm-hint">Новый шаблон будет сохранён без значения по умолчанию; текущий шаблон останется основным.</p>}
        <label className="rm-field"><span>Текст промпта шаблона</span><textarea rows={5} value={templateText} disabled={settingsBusy} onChange={event => { setTemplateText(event.target.value); clearTemplateFeedback(); }}/></label>
        <button className="rm-link-button danger" disabled={settingsBusy || templates.length <= 1} onClick={deleteSelectedTemplate}>Удалить выбранный шаблон</button>
        {templates.length <= 1 && <p className="rm-hint">Нельзя удалить последний шаблон.</p>}
        <div className="rm-inline-actions"><button className="rm-primary" disabled={settingsBusy || !templates.length || !defaultTemplateId} onClick={() => void saveTemplate()}>{saving ? 'Сохранение…' : 'Сохранить шаблон'}</button></div>
      </article>
    </section>
  </section>;
}
