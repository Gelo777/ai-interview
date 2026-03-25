import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SessionRecord } from "@/lib/types";
import {
  DEFAULT_HISTORY_RETENTION_DAYS,
  normalizeHistoryRetentionDays,
} from "@/lib/historyRetention";
import { useSettingsStore } from "@/stores/settings";
import { appPersistStorage } from "@/lib/persistStorage";

const DAY_MS = 24 * 60 * 60 * 1000;

function applyRetentionPolicy(sessions: SessionRecord[]): SessionRecord[] {
  const retentionSetting = useSettingsStore.getState().historyRetentionDays;
  if (retentionSetting === null) {
    return sessions;
  }

  const retentionDays = normalizeHistoryRetentionDays(retentionSetting);
  const retentionMs = (retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS) * DAY_MS;
  const now = Date.now();
  return sessions.filter((session) => now - session.endedAt < retentionMs);
}

interface HistoryState {
  sessions: SessionRecord[];
  addSession: (session: SessionRecord) => void;
  deleteSession: (id: string) => void;
  cleanup: () => void;
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      sessions: [],

      addSession: (session) =>
        set((s) => ({ sessions: applyRetentionPolicy([session, ...s.sessions]) })),

      deleteSession: (id) =>
        set((s) => ({ sessions: s.sessions.filter((r) => r.id !== id) })),

      cleanup: () =>
        set((s) => ({ sessions: applyRetentionPolicy(s.sessions) })),
    }),
    { name: "ai-interview-history", storage: appPersistStorage },
  ),
);
