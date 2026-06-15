import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioQualityCheck } from "@/components/dashboard/AudioQualityCheck";
import { useSettingsStore } from "@/stores/settings";
import {
  captureAudioSample,
  isTauri,
  type CaptureAudioSampleResult,
} from "@/lib/tauri";

vi.mock("@/lib/diagnostics", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  captureAudioSample: vi.fn(),
  isTauri: vi.fn(),
}));

function makeCaptureResult(): CaptureAudioSampleResult {
  return {
    output_dir: "C:\\tmp\\audio-check",
    duration_seconds: 10,
    captured_at_unix_ms: 1780000000000,
    microphone: {
      source: "mic",
      requested_device_id: "mic-device",
      device_name: "Studio Mic",
      available: true,
      sample_rate: 48000,
      sample_count: 480000,
      duration_ms: 10000,
      peak_abs: 12000,
      rms: 1500,
      file_path: "C:\\tmp\\audio-check\\mic.wav",
      detail: "ok",
    },
    system_audio: {
      source: "system",
      requested_device_id: "speaker-device",
      device_name: "Headphones",
      available: true,
      sample_rate: 48000,
      sample_count: 480000,
      duration_ms: 10000,
      peak_abs: 9000,
      rms: 900,
      file_path: "C:\\tmp\\audio-check\\system.wav",
      detail: "ok",
    },
  };
}

describe("audio recording integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      microphoneDeviceId: "mic-device",
      systemAudioDeviceId: "speaker-device",
    });
  });

  it("starts a 10 second native recording with the selected devices and renders WAV paths", async () => {
    const user = userEvent.setup();
    const result = makeCaptureResult();
    const onCompleted = vi.fn();

    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(captureAudioSample).mockResolvedValue(result);

    render(<AudioQualityCheck onCompleted={onCompleted} />);

    await user.click(screen.getByTestId("audio-quality-record-button"));

    await waitFor(() => {
      expect(captureAudioSample).toHaveBeenCalledWith({
        durationSeconds: 10,
        openOutputDir: true,
        microphoneDeviceId: "mic-device",
        systemAudioDeviceId: "speaker-device",
      });
    });
    expect(onCompleted).toHaveBeenCalledWith(result);
    expect(screen.getByTestId("audio-quality-microphone-result")).toHaveTextContent(
      "C:\\tmp\\audio-check\\mic.wav",
    );
    expect(screen.getByTestId("audio-quality-system-result")).toHaveTextContent(
      "C:\\tmp\\audio-check\\system.wav",
    );
  });

  it("does not call native recording outside the desktop runtime", async () => {
    const user = userEvent.setup();

    vi.mocked(isTauri).mockReturnValue(false);

    render(<AudioQualityCheck />);

    await user.click(screen.getByTestId("audio-quality-record-button"));

    await waitFor(() => {
      expect(screen.getByTestId("audio-quality-error")).toBeInTheDocument();
    });
    expect(captureAudioSample).not.toHaveBeenCalled();
  });
});
