import { Component, type ErrorInfo, type ReactNode } from "react";
import { logError } from "@/lib/diagnostics";
import { buildSupportReport, submitCriticalSupportReport } from "@/lib/supportReporting";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  copied: boolean;
  sending: boolean;
  reportId: string | null;
  sendStatus: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private report = "";

  state: ErrorBoundaryState = {
    error: null,
    copied: false,
    sending: false,
    reportId: null,
    sendStatus: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const details = {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    };
    logError("react.errorBoundary", "React render failed", details);
    this.report = buildSupportReport("Интерфейс временно недоступен", JSON.stringify(details, null, 2));
    void this.submitCrashReport(false);
  }

  private submitCrashReport = async (force: boolean) => {
    if (this.state.sending) {
      return;
    }

    this.setState({ sending: true, sendStatus: null });
    const result = await submitCriticalSupportReport({
      category: "desktop-crash",
      title: "Интерфейс временно недоступен",
      extra: this.report,
      throttleKey: "react-error-boundary",
      force,
    });

    this.setState({
      sending: false,
      reportId: result.reportId ?? null,
      sendStatus: result.sent
        ? "Сообщение отправлено."
        : result.reason === "missing-license"
          ? "Не найден лицензионный ключ. Сообщение можно скопировать вручную."
          : result.reason === "throttled"
            ? "Похожее сообщение уже отправлялось недавно."
            : "Не удалось отправить сообщение автоматически.",
    });
  };

  private copyReport = async () => {
    try {
      await navigator.clipboard.writeText(this.report || buildSupportReport("Интерфейс временно недоступен"));
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 1800);
    } catch {
      this.setState({ copied: false });
    }
  };

  private reload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary p-6 text-text-primary">
        <div className="max-w-xl rounded-3xl border border-danger/30 bg-bg-secondary p-6 shadow-2xl">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-danger">
            Приложение остановилось
          </div>
          <h1 className="mt-3 text-2xl font-bold">Интерфейс временно недоступен</h1>
          <p className="mt-3 text-sm leading-7 text-text-secondary">
            Можно перезагрузить окно и продолжить работу. Если проблема повторится, отправьте короткое сообщение в поддержку.
          </p>
          <div className="mt-4 rounded-2xl border border-border bg-bg-primary p-3 text-xs text-text-muted">
            Окно столкнулось с ошибкой интерфейса. Перезагрузите приложение или отправьте сообщение в поддержку.
          </div>
          {this.state.sendStatus && (
            <div className="mt-4 rounded-2xl border border-border bg-white/[0.03] p-3 text-sm text-text-secondary">
              {this.state.sendStatus}
              {this.state.reportId ? ` ID: ${this.state.reportId}` : ""}
            </div>
          )}
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={this.reload}
              className="rounded-2xl bg-accent px-4 py-2 text-sm font-semibold text-bg-primary"
            >
              Перезагрузить
            </button>
            <button
              type="button"
              onClick={() => void this.submitCrashReport(true)}
              disabled={this.state.sending}
              className="rounded-2xl border border-border bg-bg-tertiary px-4 py-2 text-sm font-semibold text-text-primary disabled:opacity-60"
            >
              {this.state.sending ? "Отправляем..." : "Отправить сообщение"}
            </button>
            <button
              type="button"
              onClick={() => void this.copyReport()}
              className="rounded-2xl border border-border bg-bg-tertiary px-4 py-2 text-sm font-semibold text-text-primary"
            >
              {this.state.copied ? "Скопировано" : "Скопировать сообщение"}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
