export interface RuntimeDiagnostic {
  origin: 'browser' | 'react';
  message: string;
  errorName?: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
}

export type RuntimeDiagnosticReporter = (diagnostic: RuntimeDiagnostic) => unknown;
export type RuntimeOwnershipPredicate = (source: string | undefined, stack: string | undefined) => boolean;

const MAX_MESSAGE = 500;
const MAX_SOURCE = 512;
const MAX_STACK = 3_000;
const MAX_EVENTS_PER_WINDOW = 5;
const RATE_WINDOW_MS = 30_000;

function redactUrl(value: string): string {
  return value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, candidate => {
    try {
      const url = new URL(candidate);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return '[url]';
    }
  });
}

/** Redacts common credential forms before a browser diagnostic crosses the RPC boundary. */
export function sanitizeRuntimeText(value: string, limit = MAX_MESSAGE): string {
  return redactUrl(value)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]*/gi, '$1: [redacted]')
    .replace(/\bauthorization\s*[:=]\s*[^\r\n]*/gi, 'authorization: [redacted]')
    .replace(/\b(api[-_ ]?key|x-redmine-api-key|token|password|authorization)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1$2[redacted]')
    .replace(/([?&][a-z0-9_.-]+=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/#[^\s"'<>]*/g, '#[redacted]')
    .slice(0, limit);
}

function safeProperty(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
}

function stringProperty(value: unknown, key: string): string | undefined {
  const result = safeProperty(value, key);
  return typeof result === 'string' ? result : undefined;
}

function safeStack(value: unknown): string | undefined {
  const stack = stringProperty(value, 'stack');
  if (!stack) return undefined;
  return sanitizeRuntimeText(stack.split('\n').slice(0, 24).join('\n'), MAX_STACK);
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

function normalizeError(value: unknown, fallbackMessage?: string): Pick<RuntimeDiagnostic, 'message' | 'errorName' | 'stack'> {
  const rawMessage = stringProperty(value, 'message') ?? (typeof value === 'string' ? value : fallbackMessage);
  const rawName = stringProperty(value, 'name');
  const stack = safeStack(value);
  return {
    message: sanitizeRuntimeText(rawMessage || 'Unhandled browser error'),
    ...(rawName ? { errorName: sanitizeRuntimeText(rawName, 80) } : {}),
    ...(stack ? { stack } : {}),
  };
}

function hasPluginSourceMarker(value?: string): boolean {
  if (!value) return false;
  const normalized = value.replaceAll('\\', '/');
  if (/(?:^|[\s(/])dsh-plugin-redmine\.js(?=$|[?#:\s)])/i.test(normalized)) return true;

  for (const match of normalized.matchAll(/(?:https?|file):\/\/[^\s)]+/gi)) {
    const candidate = match[0].replace(/[),;]+$/, '').replace(/:\d+(?::\d+)?$/, '');
    try {
      const segments = new URL(candidate).pathname.split('/').filter(Boolean).map(segment => segment.toLocaleLowerCase());
      const pluginRoute = segments.some((segment, index) => segment === 'api' && segments[index + 1] === 'plugins');
      if (pluginRoute && segments.at(-1) === 'dsh-plugin-redmine') return true;
    } catch { /* malformed source references are not ownership evidence */ }
  }
  return false;
}

/**
 * Installs bounded browser error listeners. The optional target makes the listener
 * lifecycle testable without mutating the process-wide `window` object.
 */
export function installRuntimeDiagnostics(report: RuntimeDiagnosticReporter, target?: Window, isOwned?: RuntimeOwnershipPredicate): () => void {
  const host = target ?? (typeof window === 'undefined' ? undefined : window);
  if (!host) return () => undefined;

  let reporting = false;
  let eventTimes: number[] = [];
  const emit = (diagnostic: RuntimeDiagnostic) => {
    if (reporting) return;
    const now = Date.now();
    eventTimes = eventTimes.filter(time => now - time < RATE_WINDOW_MS);
    if (eventTimes.length >= MAX_EVENTS_PER_WINDOW) return;
    eventTimes.push(now);
    reporting = true;
    try { void Promise.resolve(report(diagnostic)).catch(() => undefined); } catch { /* diagnostics must not interrupt UI behavior */ }
    finally { reporting = false; }
  };

  const belongsToPlugin = (source?: string, stack?: string) => {
    try {
      return isOwned ? isOwned(source, stack) : hasPluginSourceMarker(source) || hasPluginSourceMarker(stack);
    } catch { return false; }
  };

  const onError = (event: Event) => {
    const errorEvent = event as ErrorEvent;
    const normalized = normalizeError(errorEvent.error, errorEvent.message);
    const source = errorEvent.filename ? sanitizeRuntimeText(errorEvent.filename, MAX_SOURCE) : undefined;
    if (!belongsToPlugin(source, normalized.stack)) return;
    emit({
      origin: 'browser',
      ...normalized,
      ...(source ? { source } : {}),
      ...(safeNumber(errorEvent.lineno) !== undefined ? { line: safeNumber(errorEvent.lineno) } : {}),
      ...(safeNumber(errorEvent.colno) !== undefined ? { column: safeNumber(errorEvent.colno) } : {}),
    });
  };

  const onUnhandledRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    const normalized = normalizeError(reason);
    if (!belongsToPlugin(undefined, normalized.stack)) return;
    emit({ origin: 'browser', ...normalized });
  };

  host.addEventListener('error', onError);
  host.addEventListener('unhandledrejection', onUnhandledRejection);
  return () => {
    host.removeEventListener('error', onError);
    host.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}
