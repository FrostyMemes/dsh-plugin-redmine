import ts from 'typescript';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ARTIFACT_LIMIT = 900 * 1024;
const MAX_DIAGNOSTICS = 500;
const MAX_MESSAGE_LENGTH = 1_000;

function categoryName(category) {
  switch (category) {
    case ts.DiagnosticCategory.Error: return 'error';
    case ts.DiagnosticCategory.Warning: return 'warning';
    case ts.DiagnosticCategory.Suggestion: return 'suggestion';
    default: return 'message';
  }
}

function relativeFilename(file, root) {
  if (!file) return undefined;
  return relative(root, file.fileName).replaceAll('\\', '/').slice(0, 512);
}

/** Convert TypeScript diagnostics to a bounded artifact without source excerpts. */
export function formatBuildDiagnostics(diagnostics, root, runId = randomUUID(), time = new Date().toISOString()) {
  const records = diagnostics.slice(0, MAX_DIAGNOSTICS).map(diagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').slice(0, MAX_MESSAGE_LENGTH);
    const file = relativeFilename(diagnostic.file, root);
    const record = {
      code: diagnostic.code,
      category: categoryName(diagnostic.category),
      message,
      ...(file ? { file } : {}),
    };
    if (diagnostic.file && diagnostic.start !== undefined) {
      const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      record.line = position.line + 1;
      record.column = position.character + 1;
    }
    return record;
  });
  const artifact = { runId, time, success: !diagnostics.some(d => d.category === ts.DiagnosticCategory.Error), diagnostics: records };
  let serialized = JSON.stringify(artifact, null, 2);
  while (Buffer.byteLength(serialized, 'utf8') > ARTIFACT_LIMIT && records.length > 0) {
    records.pop();
    serialized = JSON.stringify(artifact, null, 2);
  }
  return { artifact, serialized };
}

export async function runTypecheck(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  let diagnostics = [];
  if (!configPath) {
    diagnostics = [{ category: ts.DiagnosticCategory.Error, code: 5083, messageText: 'Cannot find tsconfig.json.' }];
  } else {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) diagnostics = [config.error];
    else {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
      diagnostics = [...parsed.errors];
      if (!diagnostics.some(d => d.category === ts.DiagnosticCategory.Error)) {
        const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
        diagnostics.push(...ts.getPreEmitDiagnostics(program));
      }
    }
  }

  const host = { getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => ts.sys.newLine };
  if (diagnostics.length) process.stdout.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
  else process.stdout.write('TypeScript: no diagnostics.\n');

  const { artifact, serialized } = formatBuildDiagnostics(diagnostics, root);
  const artifactPath = resolve(root, '.dev', 'build-diagnostics.json');
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${serialized}\n`, 'utf8');
  return artifact.success;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url) || (invokedPath && pathToFileURL(invokedPath).href === import.meta.url)) {
  runTypecheck().then(success => { process.exitCode = success ? 0 : 1; }).catch(error => {
    process.stderr.write(`TypeScript diagnostics failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
  });
}
