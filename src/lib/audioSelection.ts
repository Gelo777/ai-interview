import type { AudioDeviceInfo } from "@/lib/tauri";

export type AudioSelectionRepair = {
  /** Selection to use from now on: the original id, or "" for the system default. */
  microphoneDeviceId: string;
  systemAudioDeviceId: string;
  /** Ids that no longer resolve and were dropped, for the one notice the user gets. */
  droppedMicrophoneId: string | null;
  droppedSystemAudioId: string | null;
};

/**
 * Windows endpoint ids die with the endpoint. Unplug a headset, disable an output,
 * or let a driver update rewrite the enumeration, and the id persisted last week
 * matches nothing — while a perfectly good default output sits right there.
 *
 * Keeping the dead id means every later start asks for a device that cannot exist,
 * so a selection that no longer resolves is dropped back to the system default.
 *
 * A selection is only dropped when the device list is genuinely populated for that
 * direction: an empty list means enumeration itself failed, and wiping the user's
 * choice over a transient failure is worse than carrying a stale id one more start.
 */
export function repairAudioSelection(
  selection: { microphoneDeviceId: string; systemAudioDeviceId: string },
  devices: AudioDeviceInfo[],
): AudioSelectionRepair {
  const microphone = repairOne(selection.microphoneDeviceId, devices, true);
  const systemAudio = repairOne(selection.systemAudioDeviceId, devices, false);

  return {
    microphoneDeviceId: microphone.deviceId,
    systemAudioDeviceId: systemAudio.deviceId,
    droppedMicrophoneId: microphone.dropped,
    droppedSystemAudioId: systemAudio.dropped,
  };
}

function repairOne(
  rawSelection: string,
  devices: AudioDeviceInfo[],
  isInput: boolean,
): { deviceId: string; dropped: string | null } {
  const selection = rawSelection.trim();
  if (!selection) {
    return { deviceId: "", dropped: null };
  }

  const sameDirection = devices.filter((device) => device.is_input === isInput);
  if (sameDirection.length === 0) {
    return { deviceId: selection, dropped: null };
  }

  return sameDirection.some((device) => deviceMatchesSelector(device, selection))
    ? { deviceId: selection, dropped: null }
    : { deviceId: "", dropped: selection };
}

/**
 * Mirrors the Rust matcher in `audio.rs`: a stored selection is either the endpoint
 * id or the device name, because older builds persisted the name.
 */
export function deviceMatchesSelector(
  device: AudioDeviceInfo,
  selector: string,
): boolean {
  const normalized = selector.trim().toLowerCase();
  return (
    device.id.trim().toLowerCase() === normalized ||
    device.name.trim().toLowerCase() === normalized
  );
}

/**
 * Endpoint ids are unreadable (`wasapi:{0.0.0.00000000}.{6fbf4b8b-...}`) and saying
 * one out loud helps nobody, so notices name the channel and the fix instead.
 */
export function describeDroppedSelection(repair: AudioSelectionRepair): string | null {
  const channels: string[] = [];
  if (repair.droppedMicrophoneId) {
    channels.push("микрофон");
  }
  if (repair.droppedSystemAudioId) {
    channels.push("системный звук");
  }
  if (channels.length === 0) {
    return null;
  }

  return `Сохранённое устройство (${channels.join(" и ")}) больше не подключено. Переключились на устройство Windows по умолчанию — собес идёт дальше.`;
}
