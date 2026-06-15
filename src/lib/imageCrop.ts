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

async function loadBase64Png(imageBase64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load screenshot image for crop."));
    image.src = `data:image/png;base64,${imageBase64}`;
  });
}
