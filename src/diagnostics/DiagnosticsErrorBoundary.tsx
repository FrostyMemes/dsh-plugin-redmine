import { Component, type ErrorInfo, type ReactNode } from 'react';
import { sanitizeRuntimeText, type RuntimeDiagnosticReporter } from './runtime.js';

export interface DiagnosticsErrorBoundaryProps {
  children: ReactNode;
  report: RuntimeDiagnosticReporter;
}

interface DiagnosticsErrorBoundaryState { failed: boolean }

export class DiagnosticsErrorBoundary extends Component<DiagnosticsErrorBoundaryProps, DiagnosticsErrorBoundaryState> {
  state: DiagnosticsErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): DiagnosticsErrorBoundaryState { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      void Promise.resolve(this.props.report({
        origin: 'react',
        message: sanitizeRuntimeText(error.message || 'React component failed'),
        ...(error.name ? { errorName: sanitizeRuntimeText(error.name, 80) } : {}),
        ...(error.stack ? { stack: sanitizeRuntimeText(error.stack.split('\n').slice(0, 24).join('\n'), 3_000) } : {}),
        ...(info.componentStack ? { source: sanitizeRuntimeText(info.componentStack, 512) } : {}),
      })).catch(() => undefined);
    } catch { /* reporting must not replace the error fallback */ }
  }

  private reload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  render() {
    if (this.state.failed) {
      return <section role="alert" aria-live="assertive">
        <h2>Что-то пошло не так</h2>
        <p>Не удалось отобразить плагин Redmine.</p>
        <button type="button" onClick={this.reload}>Перезагрузить страницу</button>
      </section>;
    }
    return this.props.children;
  }
}
