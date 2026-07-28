import {
  LayoutDashboard,
  ListChecks,
  LifeBuoy,
  Settings,
  History,
  Mic,
  Loader2,
  CircleUser,
} from "lucide-react";
import { useState } from "react";
import { useAppStore } from "@/stores/app";
import { formatTransferDiagnostics } from "@/lib/installProgress";
import { useT } from "@/lib/i18n";
import type { AppView } from "@/lib/types";

type NavItem = { id: AppView; label: string; icon: typeof LayoutDashboard };

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Интервью",
    items: [
      { id: "dashboard", label: "Обзор", icon: LayoutDashboard },
      { id: "readiness", label: "Готовность", icon: ListChecks },
    ],
  },
  {
    label: "Аккаунт",
    items: [
      { id: "history", label: "История", icon: History },
      { id: "support", label: "Поддержка", icon: LifeBuoy },
      { id: "settings", label: "Настройки", icon: Settings },
    ],
  },
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
  const t = useT();
  const [cancelingInstall, setCancelingInstall] = useState(false);

  const appVersion = __APP_VERSION__?.trim() ? __APP_VERSION__.trim() : null;
  const installTransferLabel = formatTransferDiagnostics(
    sttInstall.bytesDownloaded,
    sttInstall.contentLength,
    sttInstall.speedBytesPerSecond,
    sttInstall.etaSeconds,
  );
  const installPercentLabel =
    sttInstall.percent === null
      ? "подготовка"
      : `${Math.max(0, Math.min(100, Math.round(sttInstall.percent)))}%`;
  const installPhaseLabel =
    sttInstall.phase === "runtime"
      ? "голосовой модуль"
      : sttInstall.variant
        ? "точный профиль"
        : "распознавание";

  const handleCancelInstall = async () => {
    clearSttInstallQueue();
    if (!sttInstall.active) {
      return;
    }
    setCancelingInstall(true);
    setSttInstall({ detail: "Отменяем установку..." });
    try {
      const { isTauri, cancelVoskInstall } = await import("@/lib/tauri");
      if (isTauri()) {
        await cancelVoskInstall();
      }
    } catch (error) {
      console.warn("Failed to request speech install cancellation:", error);
    } finally {
      setCancelingInstall(false);
    }
  };

  const renderNavButton = ({ id, label, icon: Icon }: NavItem) => {
    const active = view === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => setView(id)}
        disabled={isInterviewActive}
        className={`group relative flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13.5px] transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
          active
            ? "bg-white/[0.08] font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
            : "text-white/55 hover:bg-white/[0.045] hover:text-white/90"
        }`}
      >
        {active && (
          <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent shadow-[0_0_8px_rgba(91,120,255,0.8)]" />
        )}
        <Icon
          className={`h-[17px] w-[17px] shrink-0 transition-colors ${
            active ? "text-accent" : "text-white/45 group-hover:text-white/70"
          }`}
        />
        <span>{t(label)}</span>
      </button>
    );
  };

  return (
    <aside className="relative z-10 flex h-full w-[248px] shrink-0 flex-col bg-[#13151c] text-white shadow-[inset_-1px_0_0_rgba(255,255,255,0.05),10px_0_30px_-18px_rgba(15,17,24,0.5)]">
      {/* subtle top light for depth */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),transparent)]" />

      <div className="relative flex h-16 items-center gap-2.5 px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-accent shadow-[0_2px_8px_-2px_rgba(59,91,219,0.7),inset_0_1px_0_rgba(255,255,255,0.25)]">
          <Mic className="h-4 w-4 text-white" />
        </span>
        <div className="leading-tight">
          <div className="text-[13.5px] font-semibold tracking-[-0.01em] text-white">
            AI Interview
          </div>
          <div className="text-[10.5px] text-white/40">{t("Ассистент собеседований")}</div>
        </div>
        {appVersion && (
          <span className="ml-auto self-start pt-0.5 font-mono text-[10px] text-white/25">
            v{appVersion}
          </span>
        )}
      </div>

      <div className="mx-4 h-px bg-white/[0.07]" />

      <nav className="relative flex-1 space-y-6 overflow-y-auto px-3 py-5">
        {navGroups.map((group) => (
          <div key={group.label}>
            <div className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/30">
              {t(group.label)}
            </div>
            <div className="space-y-0.5">
              {group.items.map(renderNavButton)}
            </div>
          </div>
        ))}
      </nav>

      {sttInstall.active && (
        <div className="relative mx-3 mb-3 space-y-2 rounded-xl border border-white/10 bg-white/[0.04] p-3">
          <div className="flex items-center gap-2 text-[11px] font-medium text-white/90">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
            <span className="truncate">
              {sttInstall.detail || "Подготавливаем распознавание..."}
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px] text-white/50">
            <span className="uppercase tracking-[0.1em]">{installPhaseLabel}</span>
            <span className="font-mono">{installPercentLabel}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-accent transition-all duration-200"
              style={{
                width:
                  sttInstall.percent === null
                    ? "35%"
                    : `${Math.max(0, Math.min(100, sttInstall.percent))}%`,
              }}
            />
          </div>
          {installTransferLabel && (
            <div className="text-[10px] text-white/45">{installTransferLabel}</div>
          )}
          {sttInstallQueue.length > 0 && (
            <div className="text-[10px] text-white/45">В очереди: {sttInstallQueue.length}</div>
          )}
          <button
            type="button"
            onClick={() => void handleCancelInstall()}
            disabled={cancelingInstall}
            className="text-[10px] font-medium text-white/60 transition-colors hover:text-white disabled:opacity-60"
          >
            {cancelingInstall ? "Отмена..." : "Отменить"}
          </button>
        </div>
      )}

      {/* «Кабинет» — закреплена внизу, в стиле пунктов меню (без кружка и шеврона) */}
      <div className="mx-4 h-px bg-white/[0.07]" />
      <div className="px-3 pb-3 pt-2">
        <button
          type="button"
          onClick={() => setView("cabinet")}
          disabled={isInterviewActive}
          className={`group flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13.5px] transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
            view === "cabinet"
              ? "bg-white/[0.08] font-medium text-white"
              : "text-white/55 hover:bg-white/[0.045] hover:text-white/90"
          }`}
        >
          <CircleUser
            className={`h-[17px] w-[17px] shrink-0 transition-colors ${
              view === "cabinet" ? "text-accent" : "text-white/45 group-hover:text-white/70"
            }`}
          />
          <span>{t("Кабинет")}</span>
        </button>
      </div>
    </aside>
  );
}
