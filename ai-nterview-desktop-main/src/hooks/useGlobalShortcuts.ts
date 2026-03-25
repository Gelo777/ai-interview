import { useEffect, useRef } from "react";
import { useSettingsStore } from "@/stores/settings";
import { isTauri } from "@/lib/tauri";
import { normalizeHotkeyToken } from "@/lib/hotkeys";

type ShortcutCallback = (action: string) => void;

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /(Mac|iPhone|iPad|iPod)/i.test(navigator.platform);
}

function keysToAccelerators(keys: string[]): string[] {
  const isMac = isMacPlatform();
  const mappedTokens = keys
    .map((k) => {
      const normalized = normalizeHotkeyToken(k);
      if (normalized === "Space") return "Space";
      if (normalized === "Meta") return isMac ? "Command" : "Super";
      if (normalized === "Ctrl") return isMac ? "Control" : "Ctrl";
      if (normalized === "Alt") return isMac ? "Option" : "Alt";
      return normalized;
    });
  const variants = new Set<string>();

  const addCandidate = (tokens: string[]) => {
    const direct = tokens.join("+").trim();
    if (direct) {
      variants.add(direct);
    }
    const physical = tokens
      .map((token) => {
        if (/^[A-Z]$/.test(token)) return `Key${token}`;
        if (/^[0-9]$/.test(token)) return `Digit${token}`;
        return token;
      })
      .join("+")
      .trim();
    if (physical) {
      variants.add(physical);
    }
  };

  addCandidate(mappedTokens);

  if (isMac) {
    addCandidate(mappedTokens.map((token) => (token === "Option" ? "Alt" : token)));
    addCandidate(mappedTokens.map((token) => (token === "Control" ? "Ctrl" : token)));
    addCandidate(mappedTokens.map((token) => (token === "Command" ? "Meta" : token)));
    addCandidate(mappedTokens.map((token) => (token === "Command" ? "CmdOrCtrl" : token)));
    addCandidate(
      mappedTokens.map((token) => (token === "Command" ? "CommandOrControl" : token)),
    );
  } else {
    addCandidate(mappedTokens.map((token) => (token === "Super" ? "Meta" : token)));
    addCandidate(mappedTokens.map((token) => (token === "Ctrl" ? "Control" : token)));
  }

  return [...variants];
}

export function useGlobalShortcuts(
  onAction: ShortcutCallback,
  enabled: boolean,
) {
  const hotkeys = useSettingsStore((s) => s.hotkeys);
  const onActionRef = useRef<ShortcutCallback>(onAction);

  useEffect(() => {
    onActionRef.current = onAction;
  }, [onAction]);

  useEffect(() => {
    if (!enabled || !isTauri()) return;

    let cleanup: (() => void) | null = null;

    async function register() {
      try {
        const { register, unregisterAll, isRegistered } = await import(
          "@tauri-apps/plugin-global-shortcut"
        );

        await unregisterAll().catch(() => {
          // Ignore cleanup failures from stale registrations.
        });

        const registeredShortcuts: string[] = [];

        for (const hk of hotkeys) {
          const candidates = keysToAccelerators(hk.keys);
          let registeredForAction = false;
          let lastError: unknown = null;

          for (const candidate of candidates) {
            const accelerator = candidate.trim();
            if (!accelerator) {
              continue;
            }

            try {
              await register(accelerator, (event) => {
                if (event.state !== "Pressed") {
                  return;
                }
                onActionRef.current(hk.action);
              });
              registeredShortcuts.push(accelerator);
              registeredForAction = true;
              break;
            } catch (err) {
              lastError = err;
            }
          }

          if (!registeredForAction) {
            console.warn(
              `Failed to register global shortcut for action '${hk.action}'. Candidates: ${candidates.join(", ")}`,
              lastError,
            );
          }
        }

        if (registeredShortcuts.length === 0) {
          cleanup = () => {
            unregisterAll().catch(console.warn);
          };
          return;
        }

        for (const shortcut of registeredShortcuts) {
          const registered = await isRegistered(shortcut).catch(() => false);
          if (!registered) {
            console.warn(`Global shortcut '${shortcut}' is not registered.`);
          }
        }

        cleanup = () => {
          unregisterAll().catch(console.warn);
        };
      } catch (err) {
        console.warn("Global shortcuts not available:", err);
      }
    }

    register();

    return () => {
      cleanup?.();
    };
  }, [hotkeys, enabled]);
}
