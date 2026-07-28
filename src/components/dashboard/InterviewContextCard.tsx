import { useCallback, useRef, useState } from "react";
import { AlertTriangle, ClipboardList, FileText, Loader2, Upload, X } from "lucide-react";
import { useSettingsStore } from "@/stores/settings";
import { useT } from "@/lib/i18n";
import {
  CONTEXT_FILE_ACCEPT,
  classifyContextFile,
  describeUnsupportedFile,
  extractContextFileText,
  maxBytesForKind,
} from "@/lib/contextFileText";
import type { ContextFile } from "@/lib/types";

const CONTEXT_FILE_MAX_COUNT = 10;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function toReadErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message || "не удалось прочитать";
}

export function InterviewContextCard({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  const interviewContext = useSettingsStore((s) => s.interviewContext);
  const setInterviewContext = useSettingsStore((s) => s.setInterviewContext);
  const contextFiles = useSettingsStore((s) => s.contextFiles);
  const addContextFiles = useSettingsStore((s) => s.addContextFiles);
  const removeContextFile = useSettingsStore((s) => s.removeContextFile);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const handleFiles = useCallback(
    async (rawFiles: FileList | File[]) => {
      setError(null);
      const list = Array.from(rawFiles);
      if (list.length === 0) return;

      const existingNames = new Set(contextFiles.map((file) => file.name));
      const problems: string[] = [];
      const accepted: ContextFile[] = [];
      let remainingSlots = CONTEXT_FILE_MAX_COUNT - contextFiles.length;

      setReading(true);
      try {
        for (const file of list) {
          if (remainingSlots <= 0) {
            problems.push(t("лимит {count} файлов", { count: CONTEXT_FILE_MAX_COUNT }));
            break;
          }
          if (existingNames.has(file.name)) {
            problems.push(t("«{name}» уже добавлен", { name: file.name }));
            continue;
          }

          const kind = classifyContextFile(file);
          if (kind === "unsupported") {
            problems.push(
              t("«{name}»: {reason}", { name: file.name, reason: describeUnsupportedFile(file) }),
            );
            continue;
          }
          const maxBytes = maxBytesForKind(kind);
          if (file.size > maxBytes) {
            problems.push(
              t("«{name}» больше {size}", { name: file.name, size: formatFileSize(maxBytes) }),
            );
            continue;
          }

          try {
            // PDF and .docx are decoded here, so what gets stored is always text.
            const content = await extractContextFileText(file, kind);
            if (!content.trim()) {
              problems.push(t("«{name}»: пустой текст", { name: file.name }));
              continue;
            }
            accepted.push({
              id: crypto.randomUUID(),
              name: file.name,
              size: file.size,
              mimeType: file.type || "text/plain",
              content,
              addedAt: Date.now(),
            });
            existingNames.add(file.name);
            remainingSlots -= 1;
          } catch (readError) {
            problems.push(
              t("«{name}»: {reason}", {
                name: file.name,
                reason: toReadErrorDetail(readError),
              }),
            );
          }
        }
      } finally {
        setReading(false);
      }

      if (accepted.length > 0) {
        addContextFiles(accepted);
      }
      if (problems.length > 0) {
        setError(problems.join(". "));
      }
    },
    [contextFiles, addContextFiles, t],
  );

  const openPicker = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  return (
    <section
      className="rise-in relative overflow-hidden rounded-[28px] border border-accent/25 bg-accent/[0.06] p-6 shadow-[0_1px_2px_rgba(20,22,40,0.05),0_20px_46px_-30px_rgba(24,28,55,0.28)]"
      style={{ animationDelay: "120ms" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-white shadow-[0_2px_8px_-2px_rgba(59,91,219,0.6)]">
            <ClipboardList className="h-4 w-4" />
          </span>
          <div>
            <h3 className="font-display text-[15px] font-bold tracking-[-0.01em] text-text-primary">
              {t("Контекст интервью")}
            </h3>
            <p className="text-xs font-medium text-accent">
              {t("Заполните перед запуском — ответы станут точнее")}
            </p>
          </div>
        </div>
        <span className="rounded-full border border-accent/25 bg-bg-card px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">
          {t("Необязательно")}
        </span>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {/* Text context */}
        <div>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.1em] text-text-secondary">
            {t("Тема и стек")}
          </label>
          <textarea
            value={interviewContext}
            onChange={(e) => setInterviewContext(e.target.value)}
            disabled={disabled}
            rows={4}
            placeholder="backend interview · concurrency, API, databases, caching, system design"
            className="block w-full resize-none rounded-xl border border-border bg-bg-card px-3.5 py-2.5
            text-sm leading-relaxed text-text-primary placeholder:text-text-muted/80
            outline-none transition-[border-color,box-shadow] duration-150
            hover:border-border-active
            focus:border-accent/70 focus:ring-4 focus:ring-accent/10
            disabled:opacity-50"
          />
        </div>

        {/* Files */}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <label className="block text-[11px] font-bold uppercase tracking-[0.1em] text-text-secondary">
              {t("Файлы")}
              <span className="ml-1.5 font-semibold normal-case tracking-normal text-text-muted">
                {contextFiles.length}/{CONTEXT_FILE_MAX_COUNT}
              </span>
            </label>
            <span className="text-[10px] font-medium text-text-muted">
              {t("PDF, Word, текст, код · до 10 МБ")}
            </span>
          </div>

          <div
            onDragOver={(event) => {
              event.preventDefault();
              if (!disabled) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              if (disabled) return;
              void handleFiles(event.dataTransfer.files);
            }}
            onClick={openPicker}
            role="button"
            tabIndex={disabled ? -1 : 0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openPicker();
              }
            }}
            className={`flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed px-3.5 py-3 transition-colors ${
              dragOver
                ? "border-accent bg-accent-muted"
                : "border-accent/30 bg-bg-card hover:border-accent hover:bg-accent-muted"
            } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-white">
              {reading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-text-primary">
                {reading ? t("Читаем файлы...") : t("Перетащите файлы или нажмите")}
              </div>
              <div className="mt-0.5 text-[11px] text-text-secondary">
                {t("Резюме или вакансия в PDF/Word, конспект темы, пример кода")}
              </div>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={CONTEXT_FILE_ACCEPT}
              disabled={disabled}
              className="hidden"
              onChange={(event) => {
                const list = event.target.files;
                if (list && list.length > 0) {
                  void handleFiles(list);
                }
                event.target.value = "";
              }}
            />
          </div>

          {error && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-muted px-2.5 py-1.5 text-[11px] font-medium text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}

          {contextFiles.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {contextFiles.map((file) => (
                <span
                  key={file.id}
                  className="group inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-bg-card py-1 pl-2 pr-1 text-[11px] shadow-[0_1px_2px_rgba(20,22,40,0.04)]"
                  title={`${file.name} · ${formatFileSize(file.size)}`}
                >
                  <FileText className="h-3 w-3 shrink-0 text-accent" />
                  <span className="max-w-[140px] truncate font-semibold text-text-primary">
                    {file.name}
                  </span>
                  <span className="shrink-0 text-text-muted">
                    {formatFileSize(file.size)}
                  </span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeContextFile(file.id);
                    }}
                    disabled={disabled}
                    className="ml-0.5 shrink-0 rounded p-0.5 text-text-muted hover:bg-danger-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
                    title={t("Удалить")}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
