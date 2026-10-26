import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { Level } from '../shared/contracts.js';
import { sanitizeRuntimeText } from './runtime.js';

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const artifactSchema = z.object({
  runId: z.string().min(1).max(100),
  time: z.string().min(1).max(64),
  success: z.boolean(),
  diagnostics: z.array(z.object({
    code: z.number().int().min(0).max(999_999),
    category: z.enum(['error', 'warning', 'suggestion', 'message']),
    message: z.string().max(2_048),
    file: z.string().max(512).optional(),
    line: z.number().int().min(1).max(10_000_000).optional(),
    column: z.number().int().min(1).max(10_000_000).optional(),
  }).strict()).max(500),
}).strict();

export type BuildDiagnosticConsumer = (
  level: Level,
  component: string,
  operation: string,
  message: string,
  fields?: Record<string, string | number | boolean | null>,
) => Promise<void> | void;

function diagnosticLevel(category: 'error' | 'warning' | 'suggestion' | 'message'): Level {
  switch (category) {
    case 'error': return 'error';
    case 'warning': return 'warning';
    case 'suggestion': return 'debug';
    default: return 'info';
  }
}

/**
 * Creates a process-local, at-most-once importer for the latest TypeScript build
 * diagnostics artifact. File and schema failures are intentionally nonfatal.
 */
export function createBuildDiagnosticsImporter() {
  const importedRuns = new Set<string>();

  return async function importBuildDiagnostics(path: string, consume: BuildDiagnosticConsumer): Promise<boolean> {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MAX_ARTIFACT_BYTES) return false;
      const contents = await readFile(path, 'utf8');
      if (Buffer.byteLength(contents, 'utf8') > MAX_ARTIFACT_BYTES) return false;
      const parsed = artifactSchema.safeParse(JSON.parse(contents));
      if (!parsed.success || importedRuns.has(parsed.data.runId)) return false;

      importedRuns.add(parsed.data.runId);
      if (importedRuns.size > 64) importedRuns.delete(importedRuns.values().next().value!);

      for (const diagnostic of parsed.data.diagnostics) {
        const fields: Record<string, string | number | boolean | null> = { code: diagnostic.code };
        if (diagnostic.file) fields.path = sanitizeRuntimeText(diagnostic.file.replaceAll('\\', '/'), 512);
        if (diagnostic.line !== undefined) fields.line = diagnostic.line;
        if (diagnostic.column !== undefined) fields.column = diagnostic.column;
        try {
          await consume(
            diagnosticLevel(diagnostic.category),
            'typescript',
            `TS${diagnostic.code}`,
            sanitizeRuntimeText(diagnostic.message, 2_048),
            fields,
          );
        } catch { /* diagnostic storage must not break the logs read */ }
      }

      try {
        await consume(
          parsed.data.success ? 'info' : 'error',
          'typescript',
          'typecheck',
          parsed.data.success ? 'TypeScript check passed' : 'TypeScript check failed',
          { status: parsed.data.success ? 'ok' : 'error', code: parsed.data.diagnostics.length, path: 'build-diagnostics.json' },
        );
      } catch { /* diagnostic storage must not break the logs read */ }
      return true;
    } catch {
      return false;
    }
  };
}
