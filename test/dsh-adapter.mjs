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
