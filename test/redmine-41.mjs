import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginService } from '../dist/core/service.js';

// Response shapes follow Redmine's maintained 4.1-stable API serializers:
// users/show.api.rsb, projects/show.api.rsb, ProjectsHelper#render_api_includes,
// and IssuesController#index. See the 4.1-stable source links documented in
// books/COMPATIBILITY.md. These fixtures deliberately omit post-4.1 fields.
const apiKey = 'redmine-41-fixture-secret';
const store = () => {
  const values = new Map();
  return { values, async get(key, fallback) { return values.has(key) ? values.get(key) : fallback; }, async set(key, value) { values.set(key, value); } };
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const assertRequest = (parsed, init, allowedPath, allowedQuery) => {
  assert.equal(parsed.origin, 'https://redmine.example');
  assert.ok(parsed.pathname.startsWith('/redmine/'), `Redmine base path was lost: ${parsed.pathname}`);
  assert.equal(init.method, 'GET');
  assert.equal(init.headers['X-Redmine-API-Key'], apiKey);
  assert.equal(init.redirect, 'error');
  assert.match(parsed.pathname.slice('/redmine/'.length), allowedPath);
  assert.deepEqual([...parsed.searchParams.keys()].sort(), [...allowedQuery].sort(), `unexpected query keys at ${parsed.pathname}`);
  assert.ok(!parsed.searchParams.has('key'), 'API key must never be placed in the URL');
};
const issue = (index) => {
  const closed = index === 100;
  const projectId = closed ? 101 : 1;
  return {
    id: 7001 + index,
    subject: closed ? 'Closed Redmine 4.1 issue' : `Open Redmine 4.1 issue ${index}`,
    description: 'Issue descriptions must not reach the panel or storage',
    journals: [{ notes: 'Journal text must not be loaded or kept' }],
    attachments: [{ filename: 'secret.txt' }],
    project: { id: projectId, name: `Project ${projectId}` },
    tracker: { id: closed ? 2 : 1, name: closed ? 'Feature' : 'Bug' },
    status: { id: closed ? 5 : 2, name: closed ? 'Resolved' : 'Open' },
    priority: { id: closed ? 3 : 2, name: closed ? 'High' : 'Normal' },
    category: { id: closed ? 101 : 1, name: 'Shared category' },
    author: { id: 50, name: 'Current User' },
    assigned_to: { id: 50, name: 'Current User' },
    updated_on: `2024-01-${String(index % 28 + 1).padStart(2, '0')}T10:00:00Z`,
  };
};
const makeHarness = (fetch) => {
  const db = store();
  const credentials = { async resolve() { return apiKey; }, async set(value) { assert.equal(value, apiKey); }, async clear() {} };
  const dsh = {
    async list() { return []; }, async register() { throw new Error('unused'); }, async validate() { throw new Error('unused'); },
    async createSession() { throw new Error('unused'); }, async sendPrompt() { throw new Error('unused'); },
    async renameSession() { throw new Error('unused'); }, async sessionExists() { return false; },
    async existingSessions() { return []; },
  };
  return { db, async service() { return PluginService.create({ store: db, credentials, dsh, logDirectory: 'unused', fetch }); } };
};

test('Redmine 4.1 REST response shapes, pagination, filters and read-only boundary', async () => {
  const requests = [];
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, init });

    const path = parsed.pathname.slice('/redmine/'.length);
    if (path === 'users/current.json') {
      assertRequest(parsed, init, /^users\/current\.json$/, []);
      return json({ user: { id: 50, login: 'fixture-user', firstname: 'Fixture', lastname: 'User', api_key: apiKey } });
    }
    if (path === 'projects.json') {
      assertRequest(parsed, init, /^projects\.json$/, ['limit', ...(parsed.searchParams.has('offset') ? ['offset'] : [])]);
      const offset = Number(parsed.searchParams.get('offset') ?? 0);
      const limit = Number(parsed.searchParams.get('limit'));
      const projects = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, name: `Project ${i + 1}`, description: 'Project descriptions are not panel metadata' }));
      return json({ projects: projects.slice(offset, offset + limit), total_count: projects.length, limit, offset });
    }
    if (path === 'issues.json') {
      assertRequest(parsed, init, /^issues\.json$/, ['limit', ...(parsed.searchParams.has('offset') ? ['offset'] : []), ...(parsed.searchParams.has('assigned_to_id') ? ['assigned_to_id'] : []), ...(parsed.searchParams.has('status_id') ? ['status_id'] : [])]);
      const offset = Number(parsed.searchParams.get('offset') ?? 0);
      const limit = Number(parsed.searchParams.get('limit'));
      const all = Array.from({ length: 101 }, (_, i) => issue(i));
      return json({ issues: all.slice(offset, offset + limit), total_count: all.length, limit, offset });
    }
    if (path === 'issue_statuses.json') {
      assertRequest(parsed, init, /^issue_statuses\.json$/, []);
      // Redmine 4.1 supplies the closed flag on the status resource. Issue rows
      // above intentionally contain only id/name, matching the 4.1 issue serializer.
      return json({ issue_statuses: [{ id: 2, name: 'Open', is_closed: false }, { id: 5, name: 'Resolved', is_closed: true }] });
    }
    if (path === 'enumerations/issue_priorities.json') {
      assertRequest(parsed, init, /^enumerations\/issue_priorities\.json$/, []);
      return json({ issue_priorities: [{ id: 2, name: 'Normal' }, { id: 3, name: 'High' }] });
    }
    const projectDetails = path.match(/^projects\/(\d+)\.json$/);
    if (projectDetails) {
      const id = Number(projectDetails[1]);
      assertRequest(parsed, init, /^projects\/\d+\.json$/, ['include']);
      assert.equal(parsed.searchParams.get('include'), 'trackers,issue_categories');
      return json({ project: {
        id, name: `Project ${id}`, description: 'Never displayed or persisted',
        trackers: [{ id: 1, name: 'Bug' }, { id: 2, name: 'Feature' }],
        issue_categories: id === 1 || id === 101 ? [{ id, name: 'Shared category' }] : [],
      } });
    }
    throw new Error(`Endpoint is outside the Redmine 4.1 MVP contract: ${parsed.pathname}`);
  };

  const harness = makeHarness(fetch);
  const service = await harness.service();
  await service.call('configure', { mockEnabled: false, developerMode: true, baseUrl: 'https://redmine.example/redmine', apiKey });

  const health = await service.call('check', {});
  assert.equal(health.status, 'ok');
  assert.equal(health.user.name, 'Fixture User');
  assert.equal(health.steps.find(step => step.name === 'Категории').status, 'ok');
  assert.equal(health.steps.find(step => step.name === 'Категории').message, 'Список доступен (проект #1)');

  const result = await service.call('list', { refresh: true });
  assert.equal(result.total, 100, 'the default issue list uses Redmine 4.1 open status grouping');
  assert.equal(result.catalog.projects.length, 101);
  assert.deepEqual(result.catalog.trackers, [{ id: 1, name: 'Bug' }, { id: 2, name: 'Feature' }]);
  assert.deepEqual(result.catalog.warnings, [], 'all Redmine 4.1 catalog requests should succeed in the happy path');
  assert.deepEqual(result.catalog.categories.map(({ id, projectId, name }) => ({ id, projectId, name })), [
    { id: 1, projectId: 1, name: 'Shared category' },
    { id: 101, projectId: 101, name: 'Shared category' },
  ]);
  assert.equal(result.rows.length, 25);
  assert.ok(result.rows.every(row => !('description' in row.issue) && !('journals' in row.issue) && !('attachments' in row.issue)));
  assert.equal(result.rows.find(row => row.issue.id === 7101), undefined, 'default Redmine 4.1 open-only filter hides the closed issue');

  const closed = await service.call('list', { filters: {
    projects: [101], statuses: ['5'], trackers: [2], priorities: [3], categories: [101],
    search: '#7101', sort: 'id-desc', page: 1, pageSize: 10,
  } });
  assert.equal(closed.total, 1);
  assert.equal(closed.rows[0].issue.id, 7101);
  assert.equal(closed.rows[0].issue.status.closed, true);
  assert.deepEqual(closed.catalog.categories.map(category => category.projectId), [101]);
  assert.ok(!JSON.stringify([health, result, closed, [...harness.db.values.values()]]).includes(apiKey));
  assert.ok(!JSON.stringify([...harness.db.values.values()]).includes('Issue descriptions must not reach'));
  assert.ok(!JSON.stringify([...harness.db.values.values()]).includes('Journal text must not'));

  const issuePages = requests.filter(({ url }) => url.pathname.endsWith('/issues.json'));
  const paginatedIssuePages = issuePages.filter(({ url }) => url.searchParams.get('limit') === '100');
  assert.deepEqual(paginatedIssuePages.slice(0, 2).map(({ url }) => [url.searchParams.get('limit'), url.searchParams.get('offset')]), [['100', '0'], ['100', '100']]);
  assert.ok(paginatedIssuePages.every(({ url }) => url.searchParams.get('assigned_to_id') === 'me' && url.searchParams.get('status_id') === '*'));
  const projectPages = requests.filter(({ url }) => url.pathname.endsWith('/projects.json') && url.searchParams.get('limit') === '100');
  assert.deepEqual([...new Set(projectPages.map(({ url }) => Number(url.searchParams.get('offset'))))].sort((a, b) => a - b), [0, 100]);
  assert.ok(requests.every(({ url }) => !/\/(?:search|documents|time_entries|trackers)\.json$/.test(url.pathname)));
  assert.ok(requests.every(({ url }) => !/\/(?:issues\/\d+|attachments|wiki|dmsf)\b/.test(url.pathname)));
  assert.ok(requests.every(({ url }) => !url.searchParams.has('key')));

  const logs = await service.call('logs', {});
  assert.ok(logs.length > 0);
  assert.ok(!JSON.stringify(logs).includes(apiKey));
});

test('Redmine 4.1 open and closed status groups work when status catalog permission is missing', async () => {
  const requestedStatusIds = [];
  const fetch = async (url, init) => {
    const parsed = new URL(url), path = parsed.pathname.slice('/redmine/'.length);
    if (path === 'users/current.json') { assertRequest(parsed, init, /^users\/current\.json$/, []); return json({ user: { id: 50, login: 'fixture-user' } }); }
    if (path === 'projects.json') { assertRequest(parsed, init, /^projects\.json$/, ['limit', ...(parsed.searchParams.has('offset') ? ['offset'] : [])]); return json({ projects: [{ id: 1, name: 'Project 1' }], total_count: 1, limit: Number(parsed.searchParams.get('limit')), offset: Number(parsed.searchParams.get('offset') ?? 0) }); }
    if (path === 'issues.json') {
      assertRequest(parsed, init, /^issues\.json$/, ['limit', ...(parsed.searchParams.has('offset') ? ['offset'] : []), ...(parsed.searchParams.has('assigned_to_id') ? ['assigned_to_id'] : []), ...(parsed.searchParams.has('status_id') ? ['status_id'] : [])]);
      const status = parsed.searchParams.get('status_id');
      requestedStatusIds.push(status);
      const openIssue = { id: 9001, subject: 'Open', project: { id: 1, name: 'Project 1' }, status: { id: 2, name: 'Open' }, assigned_to: { id: 50, name: 'Fixture User' } };
      const closedIssue = { id: 9002, subject: 'Closed', project: { id: 1, name: 'Project 1' }, status: { id: 5, name: 'Resolved' }, assigned_to: { id: 50, name: 'Fixture User' } };
      const rows = status === 'open' ? [openIssue] : status === 'closed' ? [closedIssue] : [openIssue, closedIssue];
      const limit = Number(parsed.searchParams.get('limit'));
      return json({ issues: rows.slice(0, limit), total_count: rows.length, limit, offset: 0 });
    }
    if (path === 'issue_statuses.json') { assertRequest(parsed, init, /^issue_statuses\.json$/, []); return json({ errors: ['Forbidden'] }, 403); }
    if (path === 'enumerations/issue_priorities.json') { assertRequest(parsed, init, /^enumerations\/issue_priorities\.json$/, []); return json({ issue_priorities: [] }); }
    if (path === 'projects/1.json') { assertRequest(parsed, init, /^projects\/\d+\.json$/, ['include']); assert.equal(parsed.searchParams.get('include'), 'trackers,issue_categories'); return json({ project: { id: 1, trackers: [], issue_categories: [] } }); }
    throw new Error(`Endpoint is outside the Redmine 4.1 MVP contract: ${parsed.pathname}`);
  };
  const service = await makeHarness(fetch).service();
  await service.call('configure', { mockEnabled: false, baseUrl: 'https://redmine.example/redmine', apiKey });
  const open = await service.call('list', { refresh: true });
  assert.deepEqual(requestedStatusIds, ['*', 'open', 'closed']);
  assert.deepEqual(open.rows.map(row => row.issue.id), [9001]);
  assert.ok(open.catalog.warnings.some(warning => warning.startsWith('statuses:')));
  const all = await service.call('list', { filters: { statuses: ['*'] } });
  assert.deepEqual(all.rows.map(row => row.issue.id).sort(), [9001, 9002]);
});
