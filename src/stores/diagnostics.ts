import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DiagnosticEntry } from "@/lib/diagnostics";
import { appPersistStorage } from "@/lib/persistStorage";

const MAX_DIAGNOSTIC_ENTRIES = 500;
const DUPLICATE_WINDOW_MS = 2500;

interface DiagnosticsState {
  entries: DiagnosticEntry[];
  addEntry: (entry: DiagnosticEntry) => void;
  clearEntries: () => void;
}

export const useDiagnosticsStore = create<DiagnosticsState>()(
  persist(
    (set) => ({
      entries: [],
      addEntry: (entry) =>
        set((state) => ({
          entries: (() => {
            const latest = state.entries[0];
            const isDuplicate =
              Boolean(latest) &&
              latest.level === entry.level &&
              latest.scope === entry.scope &&
              latest.message === entry.message &&
              latest.details === entry.details &&
              Math.abs(entry.timestamp - latest.timestamp) <= DUPLICATE_WINDOW_MS;

            if (isDuplicate) {
              return state.entries;
            }

            return [entry, ...state.entries].slice(0, MAX_DIAGNOSTIC_ENTRIES);
          })(),
        })),
      clearEntries: () => set({ entries: [] }),
    }),
    {
      name: "ai-interview-diagnostics",
      storage: appPersistStorage,
      partialize: (state) => ({ entries: state.entries }),
    },
  ),
);
