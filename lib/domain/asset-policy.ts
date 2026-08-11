export const MODEL_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const MODEL_IMAGE_FILE_ACCEPT = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ...MODEL_IMAGE_MIME_TYPES,
].join(",");

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const DEFAULT_MAX_RUN_IMAGE_BYTES = 30 * 1024 * 1024;

export function normalizeMimeType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function isSupportedModelImageMime(value: string): boolean {
  return MODEL_IMAGE_MIME_TYPES.includes(
    normalizeMimeType(value) as (typeof MODEL_IMAGE_MIME_TYPES)[number],
  );
}

export function isHeifLike(filename: string, mimeType: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return (
    /\.(?:heic|heif|hif)$/i.test(filename) ||
    normalized === "image/heic" ||
    normalized === "image/heif" ||
    normalized === "image/heic-sequence" ||
    normalized === "image/heif-sequence"
  );
}

export function modelImageMimeFor(filename: string, mimeType: string): string | null {
  const normalized = normalizeMimeType(mimeType);
  if (isSupportedModelImageMime(normalized)) return normalized;
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  if (/\.png$/i.test(filename)) return "image/png";
  if (/\.webp$/i.test(filename)) return "image/webp";
  return null;
}
