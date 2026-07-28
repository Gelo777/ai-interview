import { describe, expect, it, vi } from "vitest";
import {
  blobToBase64Png,
  calculateAttachedImageSize,
  calculateSourceCropRect,
  cropBase64PngByRect,
  type CropRect,
} from "@/lib/imageCrop";

function stubCanvas(payload: string) {
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
      toDataURL: () => `data:image/png;base64,${payload}`,
    } as unknown as HTMLCanvasElement;
  });

  return drawImage;
}

function stubImage(naturalWidth: number, naturalHeight: number) {
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = naturalWidth;
      naturalHeight = naturalHeight;
      private value = "";

      get src() {
        return this.value;
      }

      set src(next: string) {
        this.value = next;
        queueMicrotask(() => this.onload?.());
      }
    },
  );
}

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

  it("caps an oversized clipboard image at the longest edge and keeps the aspect ratio", () => {
    expect(calculateAttachedImageSize(3840, 2160)).toEqual({ width: 1600, height: 900 });
    expect(calculateAttachedImageSize(2160, 3840)).toEqual({ width: 900, height: 1600 });
  });

  it("leaves an already small clipboard image untouched", () => {
    expect(calculateAttachedImageSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(calculateAttachedImageSize(0, 0)).toEqual({ width: 0, height: 0 });
  });

  it("re-encodes a clipboard blob into a downscaled base64 PNG", async () => {
    const drawImage = stubCanvas("clipboard-payload");
    stubImage(3840, 2160);

    const result = await blobToBase64Png(new Blob(["fake-jpeg"], { type: "image/jpeg" }));

    expect(result).toBe("clipboard-payload");
    expect(drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 1600, 900);
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
