import { create } from "zustand";
import type { ChatMessage, LlmResponse } from "@/lib/types";

interface SessionState {
  isActive: boolean;
  mode: "live" | "safe";
  safeModeReason: string | null;
  startedAt: number | null;
  elapsedMs: number;
  messages: ChatMessage[];
  contextBuffer: ChatMessage[];
  lastLlmResponse: LlmResponse | null;
  llmResponses: LlmResponse[];
  llmRequestCount: number;
  llmLatencies: { firstToken: number; total: number }[];
  interviewerChars: number;
  userChars: number;
  isLlmLoading: boolean;

  startSession: (options?: { mode?: "live" | "safe"; safeModeReason?: string | null }) => void;
  setSafeMode: (reason: string) => void;
  setLiveMode: () => void;
  endSession: () => void;
  tick: () => void;
  addMessage: (msg: ChatMessage) => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  setLlmResponse: (resp: LlmResponse) => void;
  appendLlmText: (text: string) => void;
  finishLlmResponse: (totalLatencyMs: number) => void;
  flushContextBuffer: () => void;
  setLlmLoading: (v: boolean) => void;
  trimMessages: (limitBytes: number) => void;
}

const MESSAGE_OVERHEAD_BYTES = 256;

function estimateMessageBytes(msg: ChatMessage): number {
  return new TextEncoder().encode(msg.text).length + MESSAGE_OVERHEAD_BYTES;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  isActive: false,
  mode: "live",
  safeModeReason: null,
  startedAt: null,
  elapsedMs: 0,
  messages: [],
  contextBuffer: [],
  lastLlmResponse: null,
  llmResponses: [],
  llmRequestCount: 0,
  llmLatencies: [],
  interviewerChars: 0,
  userChars: 0,
  isLlmLoading: false,

  startSession: (options) =>
    set({
      isActive: true,
      mode: options?.mode ?? "live",
      safeModeReason: options?.safeModeReason ?? null,
      startedAt: Date.now(),
      elapsedMs: 0,
      messages: [],
      contextBuffer: [],
      lastLlmResponse: null,
      llmResponses: [],
      llmRequestCount: 0,
      llmLatencies: [],
      interviewerChars: 0,
      userChars: 0,
      isLlmLoading: false,
    }),

  setSafeMode: (reason) =>
    set({
      mode: "safe",
      safeModeReason: reason,
    }),

  setLiveMode: () =>
    set({
      mode: "live",
      safeModeReason: null,
    }),

  endSession: () =>
    set({
      isActive: false,
      mode: "live",
      safeModeReason: null,
      startedAt: null,
      elapsedMs: 0,
      messages: [],
      contextBuffer: [],
      lastLlmResponse: null,
      llmResponses: [],
      llmRequestCount: 0,
      llmLatencies: [],
      interviewerChars: 0,
      userChars: 0,
      isLlmLoading: false,
    }),

  tick: () => {
    const { startedAt } = get();
    if (startedAt) set({ elapsedMs: Date.now() - startedAt });
  },

  addMessage: (msg) =>
    set((s) => ({
      messages: [...s.messages, msg],
      contextBuffer: [...s.contextBuffer, msg],
      interviewerChars:
        s.interviewerChars +
        (msg.source === "interviewer" ? msg.text.length : 0),
      userChars:
        s.userChars + (msg.source === "user" ? msg.text.length : 0),
    })),

  updateMessage: (id, updates) =>
    set((s) => {
      const existingMessage = s.messages.find((m) => m.id === id) ?? null;
      const nextSource = updates.source ?? existingMessage?.source;
      const nextText = updates.text ?? existingMessage?.text ?? "";

      let interviewerChars = s.interviewerChars;
      let userChars = s.userChars;

      if (existingMessage?.source === "interviewer") {
        interviewerChars -= existingMessage.text.length;
      }
      if (existingMessage?.source === "user") {
        userChars -= existingMessage.text.length;
      }

      if (nextSource === "interviewer") {
        interviewerChars += nextText.length;
      }
      if (nextSource === "user") {
        userChars += nextText.length;
      }

      return {
        messages: s.messages.map((m) =>
          m.id === id ? { ...m, ...updates } : m,
        ),
        contextBuffer: s.contextBuffer.map((m) =>
          m.id === id ? { ...m, ...updates } : m,
        ),
        interviewerChars: Math.max(0, interviewerChars),
        userChars: Math.max(0, userChars),
      };
    }),

  setLlmResponse: (resp) =>
    set((s) => ({
      lastLlmResponse: resp,
      llmResponses: [...s.llmResponses, resp],
      isLlmLoading: true,
      llmRequestCount: s.llmRequestCount + 1,
    })),

  appendLlmText: (text) =>
    set((s) => ({
      lastLlmResponse: s.lastLlmResponse
        ? { ...s.lastLlmResponse, text: s.lastLlmResponse.text + text }
        : null,
      llmResponses: s.lastLlmResponse
        ? s.llmResponses.map((response) =>
            response.id === s.lastLlmResponse?.id
              ? { ...response, text: response.text + text }
              : response,
          )
        : s.llmResponses,
    })),

  finishLlmResponse: (totalLatencyMs) =>
    set((s) => ({
      lastLlmResponse: s.lastLlmResponse
        ? { ...s.lastLlmResponse, isStreaming: false, totalLatencyMs }
        : null,
      llmResponses: s.lastLlmResponse
        ? s.llmResponses.map((response) =>
            response.id === s.lastLlmResponse?.id
              ? { ...response, isStreaming: false, totalLatencyMs }
              : response,
          )
        : s.llmResponses,
      isLlmLoading: false,
      llmLatencies: [
        ...s.llmLatencies,
        {
          firstToken: s.lastLlmResponse?.firstTokenLatencyMs ?? 0,
          total: totalLatencyMs,
        },
      ],
    })),

  flushContextBuffer: () => set({ contextBuffer: [] }),

  setLlmLoading: (v) => set({ isLlmLoading: v }),

  trimMessages: (limitBytes) =>
    set((s) => {
      let totalBytes = s.messages.reduce(
        (acc, m) => acc + estimateMessageBytes(m),
        0,
      );
      if (totalBytes <= limitBytes) return s;

      const target = limitBytes * 0.9;
      const msgs = [...s.messages];
      const removedIds = new Set<string>();
      while (msgs.length > 0 && totalBytes > target) {
        const removed = msgs.shift()!;
        totalBytes -= estimateMessageBytes(removed);
        removedIds.add(removed.id);
      }
      return {
        messages: msgs,
        contextBuffer: s.contextBuffer.filter((message) => !removedIds.has(message.id)),
      };
    }),
}));
