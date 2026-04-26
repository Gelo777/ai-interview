import {
  LayoutDashboard,
  Settings,
  History,
  Mic,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { useAppStore } from "@/stores/app";
import type { AppView } from "@/lib/types";

const navItems: { id: AppView; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "Главная", icon: LayoutDashboard },
  { id: "settings", label: "Настройки", icon: Settings },
  { id: "history", label: "История", icon: History },
];

export function Sidebar() {
  const {
    view,
    setView,
    isInterviewActive,
    sttInstall,
    sttInstallQueue,
    setSttInstall,
    clearSttInstallQueue,
  } = useAppStore();
  const [cancelingInstall, setCancelingInstall] = useState(false);

  const handleCancelInstall = async () => {
    clearSttInstallQueue();
    if (!sttInstall.active) {
      return;
    }

    setCancelingInstall(true);
    setSttInstall({
      detail: "Отменяем установку...",
    });

    try {
      const { isTauri, cancelVoskInstall } = await import("@/lib/tauri");
      if (isTauri()) {
        await cancelVoskInstall();
      }
    } catch (error) {
      console.warn("Failed to request Vosk install cancellation:", error);
    } finally {
      setCancelingInstall(false);
    }
  };

  return (
    <aside className="flex h-full w-[276px] shrink-0 flex-col overflow-hidden rounded-[30px] border border-white/10 bg-[linear-gradient(180deg,rgba(17,29,46,0.95),rgba(8,14,24,0.96))] shadow-[0_26px_84px_rgba(0,0,0,0.42)] backdrop-blur-xl">
      <div className="relative border-b border-white/8 px-5 py-5">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(circle_at_top_left,rgba(87,208,255,0.28),transparent_68%)]" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#57d0ff,#7addff)] shadow-[0_12px_28px_rgba(87,208,255,0.38)]">
            <Mic className="h-5 w-5 text-slate-950" />
          </div>
          <div>
            <div className="text-sm font-bold uppercase tracking-[0.08em] text-text-primary">
              Interview Helper
            </div>
            <div className="text-[11px] text-text-muted">
              Умный помощник для собеседований
            </div>
          </div>
        </div>
      </div>

      <div className="px-5 pt-5">
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.24em] text-text-muted">
            Рабочая зона
          </div>
          <div className="mt-1 text-sm font-semibold text-text-primary">
            Панель помощника
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
            Все важное в одном месте: лицензия, готовность, история и запуск помощника.
          </p>
        </div>
      </div>

      <nav className="flex-1 space-y-1.5 px-3 py-5">
        {navItems.map(({ id, label, icon: Icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              onClick={() => setView(id)}
              disabled={isInterviewActive}
              className={`
                w-full cursor-pointer rounded-2xl px-3.5 py-3 text-left text-sm transition-all duration-200
                ${active
                  ? "border border-white/12 bg-[linear-gradient(135deg,rgba(87,208,255,0.18),rgba(115,183,255,0.12))] font-medium text-text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                  : "text-text-secondary hover:bg-white/[0.05] hover:text-text-primary"
                }
                disabled:cursor-not-allowed disabled:opacity-50
              `}
            >
              <span className="flex items-center gap-3">
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${
                    active
                      ? "border-white/14 bg-white/[0.08]"
                      : "border-white/8 bg-white/[0.04]"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                </span>
                <span className="flex-1">{label}</span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="px-4 pb-4">
        {sttInstall.active && (
          <div className="mb-3 space-y-2 rounded-2xl border border-warning/30 bg-warning-muted/70 p-4">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-warning">
              Установка Vosk
            </div>
            <div className="text-[10px] leading-relaxed text-warning">
              {sttInstall.detail || "Устанавливаем компоненты Vosk..."}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-black/20">
              <div
                className="h-full bg-warning transition-all duration-200"
                style={{
                  width:
                    sttInstall.percent === null
                      ? "35%"
                      : `${Math.max(0, Math.min(100, sttInstall.percent))}%`,
                }}
              />
            </div>
            {sttInstall.percent !== null && sttInstall.percent <= 0 && (
              <div className="text-[10px] text-warning/90">
                При большой модели некоторое время может быть 0% — это нормально.
              </div>
            )}
            {sttInstallQueue.length > 0 && (
              <div className="text-[10px] text-warning/90">
                В очереди: {sttInstallQueue.length}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                void handleCancelInstall();
              }}
              disabled={cancelingInstall}
              className="text-[10px] text-warning transition-colors hover:text-warning/80 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {cancelingInstall ? "Отмена..." : "Отменить"}
            </button>
          </div>
        )}

        <div className="rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.03))] p-4">
          <div className="mb-1 flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 text-accent" />
            <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-primary">
              Быстрый старт
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-text-muted">
            Введите лицензионный ключ, проверьте готовность и запускайте помощника.
          </p>
        </div>
      </div>
    </aside>
  );
}
