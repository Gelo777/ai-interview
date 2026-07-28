import { describe, expect, it } from "vitest";

import type { AudioDeviceInfo } from "@/lib/tauri";
import {
  describeDroppedSelection,
  repairAudioSelection,
} from "@/lib/audioSelection";

function device(overrides: Partial<AudioDeviceInfo>): AudioDeviceInfo {
  return {
    id: "wasapi:{0.0.1.00000000}.{aaaa}",
    name: "Микрофон (Realtek)",
    is_default: false,
    is_input: true,
    sample_rate: 48000,
    channels: 2,
    ...overrides,
  };
}

const MIC = device({ id: "mic-id", name: "Микрофон (Realtek)", is_input: true });
const OUTPUT = device({
  id: "wasapi:{0.0.0.00000000}.{bbbb}",
  name: "Динамики",
  is_input: false,
  is_default: true,
});

describe("repairAudioSelection", () => {
  it("keeps a selection that still resolves by id", () => {
    const repair = repairAudioSelection(
      { microphoneDeviceId: "mic-id", systemAudioDeviceId: OUTPUT.id },
      [MIC, OUTPUT],
    );

    expect(repair.microphoneDeviceId).toBe("mic-id");
    expect(repair.systemAudioDeviceId).toBe(OUTPUT.id);
    expect(repair.droppedMicrophoneId).toBeNull();
    expect(repair.droppedSystemAudioId).toBeNull();
  });

  it("keeps a selection stored as a device name by an older build", () => {
    const repair = repairAudioSelection(
      { microphoneDeviceId: "Микрофон (Realtek)", systemAudioDeviceId: "" },
      [MIC, OUTPUT],
    );

    expect(repair.microphoneDeviceId).toBe("Микрофон (Realtek)");
    expect(repair.droppedMicrophoneId).toBeNull();
  });

  it("drops the stale output id from the report and falls back to the default", () => {
    const stale = "wasapi:{0.0.0.00000000}.{6fbf4b8b-48a4-4aae-aa30-8d612e3c6578}";
    const repair = repairAudioSelection(
      { microphoneDeviceId: "mic-id", systemAudioDeviceId: stale },
      [MIC, OUTPUT],
    );

    expect(repair.systemAudioDeviceId).toBe("");
    expect(repair.droppedSystemAudioId).toBe(stale);
    // The microphone still resolves, so it must survive untouched.
    expect(repair.microphoneDeviceId).toBe("mic-id");
    expect(repair.droppedMicrophoneId).toBeNull();
  });

  it("does not match an output id against an input device", () => {
    const repair = repairAudioSelection(
      { microphoneDeviceId: OUTPUT.id, systemAudioDeviceId: "" },
      [MIC, OUTPUT],
    );

    expect(repair.droppedMicrophoneId).toBe(OUTPUT.id);
  });

  it("keeps the selection when enumeration returned nothing for that direction", () => {
    // Enumeration failing is not the same as the device being gone; wiping the
    // user's choice on a transient failure would lose it for good.
    const repair = repairAudioSelection(
      { microphoneDeviceId: "mic-id", systemAudioDeviceId: "out-id" },
      [MIC],
    );

    expect(repair.systemAudioDeviceId).toBe("out-id");
    expect(repair.droppedSystemAudioId).toBeNull();
  });

  it("leaves an empty selection alone", () => {
    const repair = repairAudioSelection(
      { microphoneDeviceId: "", systemAudioDeviceId: "  " },
      [MIC, OUTPUT],
    );

    expect(repair.microphoneDeviceId).toBe("");
    expect(repair.systemAudioDeviceId).toBe("");
    expect(describeDroppedSelection(repair)).toBeNull();
  });
});

describe("describeDroppedSelection", () => {
  it("names both channels when both went stale", () => {
    const repair = repairAudioSelection(
      { microphoneDeviceId: "gone-mic", systemAudioDeviceId: "gone-out" },
      [MIC, OUTPUT],
    );

    const notice = describeDroppedSelection(repair);
    expect(notice).toContain("микрофон и системный звук");
    // The raw endpoint id helps nobody and only bloats the notice.
    expect(notice).not.toContain("gone-out");
  });
});
