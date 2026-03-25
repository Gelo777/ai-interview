const MAC_PLATFORM_PATTERN = /(Mac|iPhone|iPad|iPod)/i
export const HOTKEY_MAX_KEYS = 4
const MODIFIER_ORDER = ["Meta", "Ctrl", "Alt", "Shift"] as const

function sortHotkeyTokens(tokens: string[]): string[] {
  const modifierOrderMap = new Map<string, number>(
    MODIFIER_ORDER.map((token, index) => [token, index]),
  )

  const modifiers: string[] = []
  const regular: string[] = []

  for (const token of tokens) {
    if (modifierOrderMap.has(token)) {
      modifiers.push(token)
    } else {
      regular.push(token)
    }
  }

  modifiers.sort(
    (a, b) =>
      (modifierOrderMap.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (modifierOrderMap.get(b) ?? Number.MAX_SAFE_INTEGER),
  )

  return [...modifiers, ...regular]
}

export function normalizeHotkeyToken(token: string): string {
  const raw = token === " " ? "Space" : token.trim()
  if (!raw) {
    return ""
  }

  const lowered = raw.toLowerCase()
  if (lowered === "alt" || lowered === "option") {
    return "Alt"
  }
  if (lowered === "control" || lowered === "ctrl") {
    return "Ctrl"
  }
  if (lowered === "shift") {
    return "Shift"
  }
  if (
    lowered === "meta" ||
    lowered === "cmd" ||
    lowered === "command" ||
    lowered === "super" ||
    lowered === "win" ||
    lowered === "windows"
  ) {
    return "Meta"
  }
  if (lowered === "space" || lowered === "spacebar") {
    return "Space"
  }
  return raw.length === 1 ? raw.toUpperCase() : raw
}

export function isModifierHotkeyToken(token: string): boolean {
  const normalized = normalizeHotkeyToken(token)
  return normalized === "Alt" || normalized === "Ctrl" || normalized === "Shift" || normalized === "Meta"
}

export function normalizeHotkeyKeys(keys: string[]): string[] {
  const normalized: string[] = []
  for (const key of keys) {
    const canonical = normalizeHotkeyToken(key)
    if (!canonical || normalized.includes(canonical)) {
      continue
    }
    normalized.push(canonical)
  }
  return sortHotkeyTokens(normalized).slice(0, HOTKEY_MAX_KEYS)
}

function isMacLikePlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false
  }
  return MAC_PLATFORM_PATTERN.test(navigator.platform)
}

function toDisplayHotkeyToken(token: string, isMac: boolean): string {
  const normalized = normalizeHotkeyToken(token)
  if (isMac) {
    if (normalized === "Alt") {
      return "⌥"
    }
    if (normalized === "Meta") {
      return "⌘"
    }
    if (normalized === "Shift") {
      return "⇧"
    }
    if (normalized === "Ctrl") {
      return "⌃"
    }
    if (normalized === "Space") {
      return "␣"
    }
    if (normalized === "Enter") {
      return "↩"
    }
    if (normalized === "Backspace") {
      return "⌫"
    }
    if (normalized === "Delete") {
      return "⌦"
    }
    if (normalized === "Tab") {
      return "⇥"
    }
    if (normalized === "Escape") {
      return "⎋"
    }
    if (normalized === "ArrowUp") {
      return "↑"
    }
    if (normalized === "ArrowDown") {
      return "↓"
    }
    if (normalized === "ArrowLeft") {
      return "←"
    }
    if (normalized === "ArrowRight") {
      return "→"
    }
  } else {
    if (normalized === "Alt") {
      return "Alt"
    }
    if (normalized === "Meta") {
      return "Win"
    }
  }
  return normalized
}

export function formatHotkey(
  keys: string[],
  separator = " + ",
): string {
  const isMac = isMacLikePlatform()
  return normalizeHotkeyKeys(keys)
    .map((key) => toDisplayHotkeyToken(key, isMac))
    .join(separator)
}
