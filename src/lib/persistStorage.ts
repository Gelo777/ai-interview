import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { isTauri, readAppState, removeAppState, writeAppState } from "@/lib/tauri";

function hasWindowObject(): boolean {
  return typeof window !== "undefined";
}

function getWebLocalStorage(): Storage | null {
  if (!hasWindowObject()) {
    return null;
  }
  return window.localStorage;
}

const webStorage: StateStorage = {
  getItem: (name) => getWebLocalStorage()?.getItem(name) ?? null,
  setItem: (name, value) => {
    getWebLocalStorage()?.setItem(name, value);
  },
  removeItem: (name) => {
    getWebLocalStorage()?.removeItem(name);
  },
};

const tauriStorage: StateStorage = {
  getItem: async (name) => {
    const fromFile = await readAppState(name);
    if (fromFile !== null) {
      return fromFile;
    }

    const legacy = getWebLocalStorage()?.getItem(name) ?? null;
    if (legacy !== null) {
      await writeAppState(name, legacy);
      getWebLocalStorage()?.removeItem(name);
    }
    return legacy;
  },
  setItem: async (name, value) => {
    await writeAppState(name, value);
    getWebLocalStorage()?.removeItem(name);
  },
  removeItem: async (name) => {
    await removeAppState(name);
    getWebLocalStorage()?.removeItem(name);
  },
};

function resolvePersistStorage(): StateStorage {
  if (hasWindowObject() && isTauri()) {
    return tauriStorage;
  }
  return webStorage;
}

export const appPersistStorage = createJSONStorage(resolvePersistStorage);
