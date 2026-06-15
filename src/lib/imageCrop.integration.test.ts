import { describe, expect, it, vi } from "vitest";
import {
  calculateSourceCropRect,
  cropBase64PngByRect,
  type CropRect,
} from "@/lib/imageCrop";

function makeImageElement({
  clientWidth,
  clientHeight,
  naturalWidth,
  naturalHeight,
}: {
  clientWidth: number;
  clientHeight: number;
  naturalWidth: number;
  naturalHeight: number;
}): HTMLImageElement {
  return {
    clientWidth,
    clientHeight,
    naturalWidth,
    naturalHeight,
  } as HTMLImageElement;
}

describe("screenshot scissors crop integration", () => {
  it("maps the visible selection to source screenshot pixels and clamps bounds", () => {
    const source = calculateSourceCropRect({
      rect: { x: 390, y: 290, width: 50, height: 40 },
      displayWidth: 400,
      displayHeight: 300,
      naturalWidth: 1600,
      naturalHeight: 900,
    });

    expect(source).toEqual({
      sourceX: 1560,
      sourceY: 870,
      sourceWidth: 40,
      sourceHeight: 30,
    });
  });

  it("renders the selected source rectangle into a new PNG payload", async () => {
    const drawImage = vi.fn();
    const originalCreateElement = document.createElement.bind(document);

    vi.spyOn(document, "createElement").mockImplementation((tagName) => {
      if (tagName.toLowerCase() !== "canvas") {
        return originalCreateElement(tagName);
      }

      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage }),
        toDataURL: () => "data:image/png;base64,cropped-payload",
      } as unknown as HTMLCanvasElement;
    });

    class TestImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private value = "";

      get src() {
        return this.value;
      }

      set src(next: string) {
        this.value = next;
      }
    }

    vi.stubGlobal("Image", class extends TestImage {
      set src(value: string) {
        super.src = value;
        queueMicrotask(() => this.onload?.());
      }
    });

    const rect: CropRect = { x: 10, y: 20, width: 30, height: 40 };
    const result = await cropBase64PngByRect(
      "original-payload",
      rect,
      makeImageElement({
        clientWidth: 100,
        clientHeight: 50,
        naturalWidth: 1000,
        naturalHeight: 500,
      }),
    );

    expect(result).toBe("cropped-payload");
    expect(drawImage).toHaveBeenCalledWith(
      expect.any(Object),
      100,
      200,
      300,
      300,
      0,
      0,
      300,
      300,
    );
  });

  it("falls back to the original screenshot when dimensions are unavailable", async () => {
    const result = await cropBase64PngByRect(
      "original-payload",
      { x: 10, y: 20, width: 30, height: 40 },
      makeImageElement({
        clientWidth: 0,
        clientHeight: 50,
        naturalWidth: 1000,
        naturalHeight: 500,
      }),
    );

    expect(result).toBe("original-payload");
  });
});
