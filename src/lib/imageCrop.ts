export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SourceCropRect = {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function calculateSourceCropRect({
  rect,
  displayWidth,
  displayHeight,
  naturalWidth,
  naturalHeight,
}: {
  rect: CropRect;
  displayWidth: number;
  displayHeight: number;
  naturalWidth: number;
  naturalHeight: number;
}): SourceCropRect | null {
  if (!displayWidth || !displayHeight || !naturalWidth || !naturalHeight) {
    return null;
  }

  const scaleX = naturalWidth / displayWidth;
  const scaleY = naturalHeight / displayHeight;
  const sourceX = clamp(Math.round(rect.x * scaleX), 0, naturalWidth - 1);
  const sourceY = clamp(Math.round(rect.y * scaleY), 0, naturalHeight - 1);

  return {
    sourceX,
    sourceY,
    sourceWidth: clamp(
      Math.round(rect.width * scaleX),
      1,
      naturalWidth - sourceX,
    ),
    sourceHeight: clamp(
      Math.round(rect.height * scaleY),
      1,
      naturalHeight - sourceY,
    ),
  };
}

export async function cropBase64PngByRect(
  imageBase64: string,
  rect: CropRect,
  imageElement: HTMLImageElement,
): Promise<string> {
  const sourceRect = calculateSourceCropRect({
    rect,
    displayWidth: imageElement.clientWidth,
    displayHeight: imageElement.clientHeight,
    naturalWidth: imageElement.naturalWidth,
    naturalHeight: imageElement.naturalHeight,
  });

  if (!sourceRect) {
    return imageBase64;
  }

  const image = await loadBase64Png(imageBase64);
  const canvas = document.createElement("canvas");
  canvas.width = sourceRect.sourceWidth;
  canvas.height = sourceRect.sourceHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return imageBase64;
  }

  ctx.drawImage(
    image,
    sourceRect.sourceX,
    sourceRect.sourceY,
    sourceRect.sourceWidth,
    sourceRect.sourceHeight,
    0,
    0,
    sourceRect.sourceWidth,
    sourceRect.sourceHeight,
  );

  const croppedDataUrl = canvas.toDataURL("image/png");
  const croppedBase64 = croppedDataUrl.split(",")[1];
  return croppedBase64 || imageBase64;
}

/**
 * Clipboard screenshots come straight off the display and can be 4K-sized, so
 * the longest edge is capped before the payload goes to the service.
 */
const MAX_ATTACHED_IMAGE_EDGE = 1600;

export function calculateAttachedImageSize(
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } {
  const longestEdge = Math.max(naturalWidth, naturalHeight);
  if (longestEdge <= 0) {
    return { width: 0, height: 0 };
  }

  const scale = Math.min(1, MAX_ATTACHED_IMAGE_EDGE / longestEdge);
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  };
}

/** Re-encodes any clipboard image (JPEG, WebP, ...) into the base64 PNG the service expects. */
export async function blobToBase64Png(blob: Blob): Promise<string> {
  const dataUrl = await readBlobAsDataUrl(blob);
  const image = await loadImageFromSrc(dataUrl);
  const { width, height } = calculateAttachedImageSize(
    image.naturalWidth,
    image.naturalHeight,
  );
  if (!width || !height) {
    throw new Error("Изображение из буфера обмена пустое.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Не удалось подготовить изображение из буфера обмена.");
  }

  ctx.drawImage(image, 0, 0, width, height);
  const base64 = canvas.toDataURL("image/png").split(",")[1];
  if (!base64) {
    throw new Error("Не удалось прочитать изображение из буфера обмена.");
  }
  return base64;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () =>
      reject(new Error("Не удалось прочитать изображение из буфера обмена."));
    reader.readAsDataURL(blob);
  });
}

async function loadBase64Png(imageBase64: string): Promise<HTMLImageElement> {
  return loadImageFromSrc(`data:image/png;base64,${imageBase64}`);
}

async function loadImageFromSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image."));
    image.src = src;
  });
}
