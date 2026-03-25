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

const navItems: { id: AppView; label: string; icon: typeof LayoutDashboard }[] =
  [
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
    <aside className="w-64 shrink-0 rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(17,27,41,0.92),rgba(10,17,27,0.96))] shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl flex flex-col h-full overflow-hidden">
      <div className="relative p-5 flex items-center gap-3 border-b border-white/6">
        <div className="absolute inset-x-0 top-0 h-20 bg-[radial-gradient(circle_at_top_left,rgba(255,135,91,0.2),transparent_65%)]" />
        <div className="relative w-11 h-11 rounded-2xl bg-[linear-gradient(135deg,#ff875b,#ffb36e)] flex items-center justify-center shadow-[0_12px_28px_rgba(255,135,91,0.35)]">
          <Mic className="w-5 h-5 text-slate-950" />
        </div>
        <div className="relative">
          <div className="text-sm font-bold text-text-primary leading-tight tracking-[0.08em] uppercase">
            Interview Helper
          </div>
          <div className="text-[11px] text-text-muted">Помощник для собеседований</div>
        </div>
      </div>

      <div className="px-5 pt-5">
        <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.24em] text-text-muted">Рабочая зона</div>
          <div className="mt-1 text-sm font-semibold text-text-primary">Панель помощника</div>
          <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
            Всё важное в одном месте: лицензия, готовность, история и запуск помощника.
          </p>
        </div>
      </div>

      <nav className="flex-1 px-3 py-5 space-y-1.5">
        {navItems.map(({ id, label, icon: Icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              onClick={() => setView(id)}
              disabled={isInterviewActive}
              className={`
                w-full flex items-center gap-3 px-3.5 py-3 rounded-2xl text-sm
                transition-all duration-200 cursor-pointer text-left
                ${
                  active
                    ? "bg-[linear-gradient(135deg,rgba(255,135,91,0.18),rgba(101,178,255,0.1))] text-text-primary font-medium border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                    : "text-text-secondary hover:text-text-primary hover:bg-white/[0.04]"
                }
                disabled:opacity-50 disabled:cursor-not-allowed
              `}
            >
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${active ? "border-white/10 bg-white/[0.08]" : "border-white/6 bg-white/[0.03]"}`}>
                <Icon className="w-4 h-4 shrink-0" />
              </span>
              <span className="flex-1">{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="px-4 pb-4">
        {sttInstall.active && (
          <div className="p-4 mb-3 bg-warning-muted/70 border border-warning/30 rounded-2xl space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-warning">Установка Vosk</div>
            <div className="text-[10px] text-warning leading-relaxed">
              {sttInstall.detail || "Устанавливаем компоненты Vosk..."}
            </div>
            <div className="h-1.5 rounded-full bg-black/20 overflow-hidden">
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
            {sttInstallQueue.length > 0 && (
              <div className="text-[10px] text-warning/90">
                Queue: {sttInstallQueue.length}
                
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                void handleCancelInstall();
              }}
              disabled={cancelingInstall}
              className="text-[10px] text-warning hover:text-warning/80 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {cancelingInstall ? "Отмена..." : "Отменить"}
            </button>
          </div>
        )}
        <div className="rounded-2xl border border-white/6 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-4">
          <div className="flex items-center gap-1.5 mb-1">
            <Zap className="w-3.5 h-3.5 text-accent" />
            <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-primary">
              Быстрый старт
            </span>
          </div>
          <p className="text-[11px] text-text-muted leading-relaxed">
            Введите лицензионный ключ, проверьте готовность и запускайте помощника.
          </p>
        </div>
      </div>
    </aside>
  );
}
