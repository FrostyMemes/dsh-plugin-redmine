import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createBuildDiagnosticsImporter } from '../dist/diagnostics/build-importer.js';
import { installRuntimeDiagnostics, sanitizeRuntimeText } from '../dist/diagnostics/runtime.js';
import { formatBuildDiagnostics } from '../scripts/typecheck.mjs';

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), 'redmine-diagnostics-'));
}

test('build importer records real TypeScript diagnostics without source excerpts and imports a run once', async () => {
  const directory = await temporaryDirectory();
  try {
    const sourcePath = join(directory, 'sample.ts');
    await writeFile(sourcePath, 'const value: number = "not a number";\nexport { value };\n', 'utf8');
    const program = ts.createProgram([sourcePath], { noEmit: true, strict: true, target: ts.ScriptTarget.ES2022 });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.ok(diagnostics.some(diagnostic => diagnostic.code === 2322));

    const formatted = formatBuildDiagnostics(diagnostics, directory, 'run-real-ts-error', '2026-10-25T00:00:00.000Z');
    assert.equal(formatted.artifact.success, false);
    assert.ok(formatted.artifact.diagnostics.some(diagnostic => diagnostic.code === 2322 && diagnostic.file === 'sample.ts'));
    assert.ok(!formatted.serialized.includes('const value: number'));
    const artifactPath = join(directory, 'build-diagnostics.json');
    await writeFile(artifactPath, formatted.serialized, 'utf8');

    const imported = [];
    const importer = createBuildDiagnosticsImporter();
    const consume = (...args) => imported.push(args);
    assert.equal(await importer(artifactPath, consume), true);
    assert.equal(await importer(artifactPath, consume), false);
    assert.ok(imported.some(([level, component, operation]) => level === 'error' && component === 'typescript' && operation === 'TS2322'));
    assert.ok(imported.some(([, , operation, message]) => operation === 'typecheck' && message === 'TypeScript check failed'));
    assert.equal(imported.length, formatted.artifact.diagnostics.length + 1);
    assert.ok(imported[0][4].path === 'sample.ts');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('clean typecheck runs still create a success event', async () => {
  const directory = await temporaryDirectory();
  try {
    const artifactPath = join(directory, 'build-diagnostics.json');
    await writeFile(artifactPath, JSON.stringify({ runId: 'run-clean', time: '2026-10-25T00:00:00.000Z', success: true, diagnostics: [] }), 'utf8');
    const imported = [];
    assert.equal(await createBuildDiagnosticsImporter()(artifactPath, (...args) => imported.push(args)), true);
    assert.deepEqual(imported.map(row => row.slice(0, 4)), [['info', 'typescript', 'typecheck', 'TypeScript check passed']]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('build importer ignores malformed, invalid, missing, and oversized artifacts without throwing', async () => {
  const directory = await temporaryDirectory();
  try {
    const malformed = join(directory, 'malformed.json');
    const invalid = join(directory, 'invalid.json');
    const oversized = join(directory, 'oversized.json');
    await writeFile(malformed, '{', 'utf8');
    await writeFile(invalid, JSON.stringify({ runId: 'bad', time: 'today', success: 'yes', diagnostics: [] }), 'utf8');
    await writeFile(oversized, ' '.repeat(1024 * 1024 + 1), 'utf8');
    const importer = createBuildDiagnosticsImporter();
    const consume = () => assert.fail('invalid artifacts must not be consumed');
    assert.equal(await importer(join(directory, 'missing.json'), consume), false);
    assert.equal(await importer(malformed, consume), false);
    assert.equal(await importer(invalid, consume), false);
    assert.equal(await importer(oversized, consume), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('build importer redacts credentials, bearer values, URL query strings, and fragments', async () => {
  const directory = await temporaryDirectory();
  try {
    const artifactPath = join(directory, 'build-diagnostics.json');
    await writeFile(artifactPath, JSON.stringify({
      runId: 'run-redacted', time: '2026-10-25T00:00:00.000Z', success: false,
      diagnostics: [{
        code: 1234,
        category: 'error',
        message: 'Authorization: Bearer bearer-secret; API key=key-secret at https://user:pass@example.test/file?token=url-secret#fragment-secret',
        file: 'src/file.ts',
      }],
    }), 'utf8');
    const imported = [];
    assert.equal(await createBuildDiagnosticsImporter()(artifactPath, (...args) => imported.push(args)), true);
    const message = imported[0][3];
    assert.ok(message.includes('[redacted]'));
    for (const secret of ['bearer-secret', 'key-secret', 'url-secret', 'fragment-secret', 'user', 'pass']) assert.ok(!message.includes(secret));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser runtime listener bounds rate, sanitizes diagnostics, and cleans up', () => {
  const target = new EventTarget();
  const diagnostics = [];
  const cleanup = installRuntimeDiagnostics(diagnostic => diagnostics.push(diagnostic), target);
  const unrelated = new Event('error');
  Object.assign(unrelated, {
    message: 'Another extension failed in dsh-plugin-redmine',
    filename: 'https://example.test/other.js',
    error: Object.assign(new Error('Another extension failed'), { stack: 'Error: Another extension failed\n at E:/Programming/projects/dsh-plugin-redmine/test/diagnostics.mjs:1:1' }),
  });
  target.dispatchEvent(unrelated);
  assert.equal(diagnostics.length, 0);

  const errorEvent = new Event('error');
  Object.assign(errorEvent, {
    message: 'Failed with API key=runtime-secret',
    filename: 'https://user:pass@example.test/dsh-plugin-redmine.js?token=source-secret#section-secret',
    lineno: 4,
    colno: 9,
    error: Object.assign(new Error('Failure API key=runtime-secret'), { stack: 'Error: https://example.test/dsh-plugin-redmine.js?token=stack-secret#frag\n at app.js:4:9' }),
  });
  for (let index = 0; index < 6; index++) target.dispatchEvent(errorEvent);
  const rejection = new Event('unhandledrejection');
  Object.assign(rejection, { reason: Object.assign(new Error('Rejected'), { name: 'TypeError' }) });
  target.dispatchEvent(rejection);

  assert.equal(diagnostics.length, 5);
  assert.equal(diagnostics[0].origin, 'browser');
  assert.equal(diagnostics[0].line, 4);
  assert.equal(diagnostics[0].column, 9);
  assert.ok(diagnostics[0].source.includes('example.test'));
  const joined = JSON.stringify(diagnostics);
  for (const secret of ['runtime-secret', 'source-secret', 'stack-secret', 'section-secret', 'user:pass']) assert.ok(!joined.includes(secret));
  assert.ok(diagnostics[0].stack.length <= 3_000);

  cleanup();
  target.dispatchEvent(rejection);
  assert.equal(diagnostics.length, 5);
});

test('browser unhandled rejections are captured only when their stack identifies the plugin', () => {
  const target = new EventTarget();
  const diagnostics = [];
  const cleanup = installRuntimeDiagnostics(diagnostic => diagnostics.push(diagnostic), target);
  const unrelated = new Event('unhandledrejection');
  Object.assign(unrelated, { reason: Object.assign(new Error('Unrelated rejection'), { stack: 'Error: Unrelated rejection\n at E:/Programming/projects/dsh-plugin-redmine/test/diagnostics.mjs:4:1' }) });
  target.dispatchEvent(unrelated);
  const owned = new Event('unhandledrejection');
  Object.assign(owned, { reason: Object.assign(new Error('Plugin rejection'), { stack: 'Error: Plugin rejection\n at dsh-plugin-redmine.js:12:4' }) });
  target.dispatchEvent(owned);
  cleanup();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].message, 'Plugin rejection');
});

test('runtime ownership accepts the Redmine plugin endpoint and rejects incidental path text', () => {
  const target = new EventTarget();
  const diagnostics = [];
  const cleanup = installRuntimeDiagnostics(diagnostic => diagnostics.push(diagnostic), target);
  const unrelated = new Event('error');
  Object.assign(unrelated, { message: 'Unrelated', filename: 'https://example.test/api/plugins/team/other-plugin', error: new Error('Unrelated') });
  target.dispatchEvent(unrelated);
  const owned = new Event('error');
  Object.assign(owned, { message: 'Plugin error', filename: 'https://example.test/api/plugins/team/dsh-plugin-redmine', error: new Error('Plugin error') });
  target.dispatchEvent(owned);
  cleanup();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].source, 'https://example.test/api/plugins/team/dsh-plugin-redmine');
});

test('runtime text sanitization bounds output and scrubs cookie and bearer patterns', () => {
  const result = sanitizeRuntimeText('Cookie: session=cookie-secret; Bearer bearer-secret; ?password=query-secret#fragment-secret', 64);
  assert.ok(result.length <= 64);
  for (const secret of ['cookie-secret', 'bearer-secret', 'query-secret', 'fragment-secret']) assert.ok(!result.includes(secret));
});
