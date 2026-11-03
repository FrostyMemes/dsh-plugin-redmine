import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshAdapter } from '../dist/host/dsh-adapter.js';

test('session lookup uses the installed SessionSummary sessionId field', async () => {
  let listCalls = 0;
  const services = {
    workspaceRegistry: { archivedSessionIds: ['archived'], list: () => [], get: () => undefined, create: async () => { throw Error('unused'); } },
    sessionController: {
      async create() { throw Error('unused'); },
      async prompt() { throw Error('unused'); },
      async list() { listCalls++; return { items: [{ sessionId: 'live', running: false, blank: false, updatedAt: 0, agentAvailable: false }] }; },
      async rename() { throw Error('unused'); },
    },
  };
  const adapter = createDshAdapter(services);
  assert.equal(await adapter.sessionExists('live'), true);
  assert.equal(await adapter.sessionExists('missing'), false);
  assert.equal(await adapter.sessionExists('archived'), false);
  assert.equal(listCalls, 2);
});

test('batch session lookup lists DSH once, preserves requested order, and excludes archived sessions', async () => {
  let listCalls = 0;
  const services = {
    workspaceRegistry: { archivedSessionIds: ['archived'], list: () => [], get: () => undefined, create: async () => { throw Error('unused'); } },
    sessionController: {
      async create() { throw Error('unused'); },
      async prompt() { throw Error('unused'); },
      async list() { listCalls++; return { items: [{ sessionId: 'second' }, { sessionId: 'first' }, { sessionId: 'unrelated' }] }; },
      async rename() { throw Error('unused'); },
    },
  };
  const adapter = createDshAdapter(services);
  assert.deepEqual(await adapter.existingSessions(['first', 'missing', 'second', 'archived', 'first']), ['first', 'second']);
  assert.equal(listCalls, 1);
  assert.deepEqual(await adapter.existingSessions(['archived']), []);
  assert.equal(listCalls, 1);
});

test('session title adapter forwards the issue subject to native rename', async () => {
  let renamed;
  const services = {
    workspaceRegistry: { archivedSessionIds: [], list: () => [], get: () => undefined, create: async () => { throw Error('unused'); } },
    sessionController: {
      async create() { throw Error('unused'); },
      async prompt() { throw Error('unused'); },
      async list() { return { items: [] }; },
      async rename(input) { renamed = input; return { title: input.title.slice(0, 24), seq: 1 }; },
    },
  };
  const adapter = createDshAdapter(services);
  const title = 'Task subject from Redmine';
  await adapter.renameSession('session-1', title);
  assert.deepEqual(renamed, { sessionId: 'session-1', title });
});

test('plan-mode adapter pins and preflights the active preset, then uses its scoped service', async () => {
  const agent = { id: 'session-plan', ctx: {} }, calls = [], state = { active: false };
  const planMode = {
    set(target, active) { calls.push(['set', target, active]); state.active = active; return 'committed'; },
    get(target) { calls.push(['get', target]); return { ...state }; },
  };
  const services = {
    workspaceRegistry: { archivedSessionIds: [], list: () => [], get: () => undefined, create: async () => { throw Error('unused'); } },
    agentPresets: {
      defaultId: 'planning',
      async resolve(id) { calls.push(['resolve', id]); return { id }; },
      async compositionInventory() { return [{ id: 'planning', rows: [{ moduleName: '@deepseek-ai/dsh-plan-mode', enabled: true, fiberState: 2 }] }]; },
      serviceFor(target, name) { calls.push(['serviceFor', target, name]); return planMode; },
    },
    sessionController: {
      async create(request) { calls.push(['create', request]); return { sessionId: request.sessionId, agentPreset: request.agentPreset }; },
      async resolveAgent(sessionId) { assert.equal(sessionId, 'session-plan'); return { agent }; },
      async prompt() { throw Error('unused'); },
      async list() { return { items: [] }; },
      async rename() { throw Error('unused'); },
    },
  };
  const adapter = createDshAdapter(services);
  assert.equal(await adapter.planModePreset(), 'planning');
  assert.equal(await adapter.createSession('workspace-1', 'session-plan', 'planning'), 'session-plan');
  await adapter.enablePlanMode('session-plan');
  assert.deepEqual(calls.find(call => call[0] === 'create'), ['create', { workspaceId: 'workspace-1', sessionId: 'session-plan', agentPreset: 'planning' }]);
  assert.ok(calls.some(call => call[0] === 'serviceFor' && call[2] === 'planMode'));
  assert.deepEqual(calls.find(call => call[0] === 'set'), ['set', agent, true]);
  assert.equal(state.active, true);
});

test('plan-mode preflight rejects disabled, failed, or unmounted package rows before session creation', async () => {
  for (const row of [
    { moduleName: '@deepseek-ai/dsh-plan-mode', enabled: false, fiberState: 2 },
    { moduleName: '@deepseek-ai/dsh-plan-mode', enabled: true, fiberState: 3 },
    { moduleName: '@deepseek-ai/dsh-plan-mode', enabled: true },
  ]) {
    let createCalls = 0;
    const services = {
      workspaceRegistry: { archivedSessionIds: [], list: () => [], get: () => undefined, create: async () => { throw Error('unused'); } },
      agentPresets: {
        defaultId: 'standard',
        async resolve(id) { return { id }; },
        async compositionInventory() { return [{ id: 'standard', rows: [row] }]; },
        serviceFor() { throw Error('must not reach service after failed preflight'); },
      },
      sessionController: {
        async create() { createCalls++; throw Error('must not create'); },
        async resolveAgent() { throw Error('unused'); },
        async prompt() { throw Error('unused'); },
        async list() { return { items: [] }; },
        async rename() { throw Error('unused'); },
      },
    };
    const adapter = createDshAdapter(services);
    await assert.rejects(adapter.planModePreset(), /does not contain active package|не содержит активный пакет/i);
    assert.equal(createCalls, 0);
  }
});

test('session creation marks an unexpected preset so the core can keep that operation blocked', async () => {
  const services = {
    workspaceRegistry: { archivedSessionIds: [], list: () => [], get: () => undefined, create: async () => { throw Error('unused'); } },
    sessionController: {
      async create(request) { return { sessionId: request.sessionId, agentPreset: 'different-preset' }; },
      async resolveAgent() { throw Error('unused'); },
      async prompt() { throw Error('unused'); },
      async list() { return { items: [] }; },
      async rename() { throw Error('unused'); },
    },
  };
  const adapter = createDshAdapter(services);
  await assert.rejects(adapter.createSession('workspace-1','session-mismatch','expected-preset'), error => {
    assert.equal(error.sessionId,'session-mismatch');
    assert.equal(error.planModePresetMismatch,true);
    assert.match(error.message,/другим preset/i);
    return true;
  });
});
