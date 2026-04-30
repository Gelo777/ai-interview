import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { applyCaptureProtectionPreference } from "@/lib/captureProtection";
import type { PermissionStatus } from "@/lib/types";
import { useSettingsStore } from "@/stores/settings";

type ProtectionState = {
  status: PermissionStatus;
  title: string;
  detail: string;
};

function resolveProtectionState(
  os: string | null,
  captureProtection: string | null,
  protectOverlay: boolean,
  lastError: string | null,
): ProtectionState {
  if (lastError) {
    return {
      status: "denied",
      title: "Не удалось переключить видимость",
      detail: lastError,
    };
  }

  const normalizedOs = (os ?? "").toLowerCase();
  const normalizedProtection = (captureProtection ?? "").toLowerCase();

  if (normalizedOs.includes("linux")) {
    return {
      status: "unknown",
      title: "На Linux защита ограничена",
      detail:
        "У Linux нет единого надежного системного API для скрытия окна из screen sharing. Переключатель сохраняет режим, но эффект зависит от окружения.",
    };
  }

  if (normalizedProtection !== "supported") {
    return {
      status: "unknown",
      title: "Платформа не подтвердила защиту",
      detail:
        "Можно переключать режим, но перед интервью лучше проверить поведение в тестовом звонке.",
    };
  }

  if (protectOverlay) {
    return {
      status: "granted",
      title: "Приложение скрыто при шаринге",
      detail:
        "Helper виден вам локально, но должен пропадать из демонстрации экрана, записи и системного захвата.",
    };
  }

  return {
    status: "unknown",
    title: "Приложение видно при шаринге",
    detail:
      "Этот режим удобен для отладки, показа ученику или записи демо. Перед реальным собеседованием лучше снова включить скрытие.",
  };
}

export function ScreenShareProtectionCard() {
  const protectOverlay = useSettingsStore((state) => state.protectOverlay);
  const setProtectOverlay = useSettingsStore((state) => state.setProtectOverlay);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<{
    os: string | null;
    captureProtection: string | null;
  }>({
    os: null,
    captureProtection: null,
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { getPlatformInfo, isTauri } = await import("@/lib/tauri");
      if (!isTauri()) {
        setPlatform({ os: "browser", captureProtection: "unknown" });
        return;
      }
      const info = await getPlatformInfo();
      setPlatform({ os: info.os, captureProtection: info.capture_protection });
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleVisibility = useCallback(async () => {
    const nextProtectOverlay = !protectOverlay;
    setLastError(null);
    setProtectOverlay(nextProtectOverlay);
    setApplying(true);

    try {
      await applyCaptureProtectionPreference(nextProtectOverlay);
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Неизвестная ошибка переключения видимости.";
      setLastError(detail);
    } finally {
      setApplying(false);
    }
  }, [protectOverlay, setProtectOverlay]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const state = resolveProtectionState(
    platform.os,
    platform.captureProtection,
    protectOverlay,
    lastError,
  );

  return (
    <Card
      title="Видимость при шаринге"
      description="По умолчанию helper скрывается из демонстрации. Здесь можно быстро показать или снова спрятать приложение."
    >
      <div className="space-y-4">
        <StatusIndicator
          status={loading || applying ? "checking" : state.status}
          label={state.title}
          description={state.detail}
        />

        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <ShieldCheck className="h-4 w-4 text-success" />
            Текущий режим
          </div>
          <div className="mt-2 text-sm leading-relaxed text-text-secondary">
            {protectOverlay
              ? "Скрываем приложение из шаринга экрана. Это безопасный режим для интервью."
              : "Показываем приложение в шаринге. Это удобно для тестов, демо и поддержки."}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant={protectOverlay ? "secondary" : "primary"}
            onClick={() => void toggleVisibility()}
            disabled={applying}
            icon={
              applying ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : protectOverlay ? (
                <Eye className="h-4 w-4" />
              ) : (
                <EyeOff className="h-4 w-4" />
              )
            }
          >
            {protectOverlay ? "Показать при шаринге" : "Скрыть при шаринге"}
          </Button>

          <Button
            variant="ghost"
            onClick={() => void refresh()}
            disabled={loading}
            icon={<RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />}
          >
            Обновить статус
          </Button>

          <div className="text-xs text-text-muted">
            OS: {platform.os ?? "unknown"}, capture:{" "}
            {platform.captureProtection ?? "unknown"}
          </div>
        </div>
      </div>
    </Card>
  );
}
