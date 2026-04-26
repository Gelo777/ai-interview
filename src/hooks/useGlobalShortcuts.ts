import { useEffect, useRef } from "react";
import { useSettingsStore } from "@/stores/settings";
import { isTauri } from "@/lib/tauri";
import { normalizeHotkeyToken } from "@/lib/hotkeys";
import { logInfo, logWarn } from "@/lib/diagnostics";

type ShortcutCallback = (action: string) => void;

let globalShortcutsBlockedByAcl = false;
let globalShortcutsAclLogShown = false;

function isAclDeniedError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return text.toLowerCase().includes("not allowed by acl");
}

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
    if (!enabled) {
      logInfo("shortcuts.global", "Global shortcuts disabled");
      return;
    }
    if (!isTauri()) {
      logInfo("shortcuts.global", "Global shortcuts skipped (non-Tauri mode)");
      return;
    }
    if (globalShortcutsBlockedByAcl) {
      if (!globalShortcutsAclLogShown) {
        logWarn(
          "shortcuts.global",
          "Global shortcuts are disabled because plugin access is blocked by ACL",
        );
        globalShortcutsAclLogShown = true;
      }
      return;
    }

    let cleanup: (() => void) | null = null;

    async function register() {
      try {
        const { register, unregisterAll, isRegistered } = await import(
          "@tauri-apps/plugin-global-shortcut"
        );

        await unregisterAll().catch(() => {
          // Ignore cleanup failures from stale registrations.
        });
        logInfo("shortcuts.global", "Starting global shortcut registration");

        const registeredShortcuts: string[] = [];

        for (const hk of hotkeys) {
          const customCandidates = keysToAccelerators(hk.keys);
          const fallbackCandidates = keysToAccelerators(hk.default);
          const tryRegister = async (
            candidates: string[],
          ): Promise<{ ok: boolean; used: string | null; error: unknown }> => {
            const unique = [...new Set(candidates.map((value) => value.trim()).filter(Boolean))];
            let lastError: unknown = null;
            for (const accelerator of unique) {
              try {
                await register(accelerator, (event) => {
                  if (event.state !== "Pressed") {
                    return;
                  }
                  onActionRef.current(hk.action);
                });
                registeredShortcuts.push(accelerator);
                return { ok: true, used: accelerator, error: null };
              } catch (err) {
                if (isAclDeniedError(err)) {
                  return { ok: false, used: null, error: err };
                }
                lastError = err;
              }
            }
            return { ok: false, used: null, error: lastError };
          };

          const customResult = await tryRegister(customCandidates);
          if (isAclDeniedError(customResult.error)) {
            globalShortcutsBlockedByAcl = true;
            globalShortcutsAclLogShown = true;
            logWarn(
              "shortcuts.global",
              "Global shortcuts are blocked by ACL; skipping registration",
              {
                action: hk.action,
                error: customResult.error,
              },
            );
            break;
          }
          if (customResult.ok) {
            continue;
          }

          const fallbackResult = await tryRegister(fallbackCandidates);
          if (isAclDeniedError(fallbackResult.error)) {
            globalShortcutsBlockedByAcl = true;
            globalShortcutsAclLogShown = true;
            logWarn(
              "shortcuts.global",
              "Global shortcuts are blocked by ACL; skipping fallback registration",
              {
                action: hk.action,
                error: fallbackResult.error,
              },
            );
            break;
          }
          if (!fallbackResult.ok) {
            logWarn(
              "shortcuts.global",
              `Failed to register shortcut '${hk.action}'`,
              {
                action: hk.action,
                candidates: customCandidates,
                fallbackCandidates,
                error: customResult.error ?? fallbackResult.error ?? null,
              },
            );
            continue;
          }

          logWarn(
            "shortcuts.global",
            `Custom shortcut fallback used for '${hk.action}'`,
            {
              action: hk.action,
              fallback: fallbackResult.used,
              customCandidates,
            },
          );
        }

        if (registeredShortcuts.length === 0) {
          logWarn(
            "shortcuts.global",
            "No global shortcuts were registered",
          );
          cleanup = () => {
            unregisterAll().catch((error: unknown) => {
              logWarn("shortcuts.global", "Failed to cleanup global shortcuts", error);
            });
          };
          return;
        }

        for (const shortcut of registeredShortcuts) {
          const registered = await isRegistered(shortcut).catch(() => false);
          if (!registered) {
            logWarn("shortcuts.global", `Shortcut '${shortcut}' is not active after registration`);
          }
        }
        logInfo("shortcuts.global", "Global shortcuts registered", {
          shortcuts: registeredShortcuts,
        });

        cleanup = () => {
          unregisterAll().catch((error: unknown) => {
            logWarn("shortcuts.global", "Failed to cleanup global shortcuts", error);
          });
        };
      } catch (err) {
        logWarn("shortcuts.global", "Global shortcuts plugin not available", err);
      }
    }

    register();

    return () => {
      cleanup?.();
    };
  }, [hotkeys, enabled]);
}
