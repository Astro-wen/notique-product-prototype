export type ParsedByteRange =
  | { kind: "none" }
  | { kind: "range"; start: number; end: number; length: number }
  | { kind: "unsatisfiable" };

export type ByteRangeResponsePlan = {
  status: 200 | 206 | 416;
  acceptRanges: "bytes";
  contentLength: number;
  contentRange?: string;
  range?: { offset: number; length: number };
};

function nonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseSingleByteRange(
  header: string | null,
  totalSize: number,
): ParsedByteRange {
  if (!header) return { kind: "none" };
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
    return { kind: "unsatisfiable" };
  }
  const match = /^bytes\s*=\s*([^,]+)$/i.exec(header.trim());
  if (!match || totalSize === 0) return { kind: "unsatisfiable" };
  const value = match[1].trim();
  const parts = /^(\d*)-(\d*)$/.exec(value);
  if (!parts || (!parts[1] && !parts[2])) return { kind: "unsatisfiable" };

  if (!parts[1]) {
    const suffixLength = nonNegativeInteger(parts[2]);
    if (!suffixLength) return { kind: "unsatisfiable" };
    const length = Math.min(suffixLength, totalSize);
    const start = totalSize - length;
    return { kind: "range", start, end: totalSize - 1, length };
  }

  const start = nonNegativeInteger(parts[1]);
  if (start == null || start >= totalSize) return { kind: "unsatisfiable" };
  const requestedEnd = parts[2] ? nonNegativeInteger(parts[2]) : totalSize - 1;
  if (requestedEnd == null || requestedEnd < start) return { kind: "unsatisfiable" };
  const end = Math.min(requestedEnd, totalSize - 1);
  return { kind: "range", start, end, length: end - start + 1 };
}

export function planByteRangeResponse(
  header: string | null,
  totalSize: number,
): ByteRangeResponsePlan {
  const parsed = parseSingleByteRange(header, totalSize);
  if (parsed.kind === "unsatisfiable") {
    return {
      status: 416,
      acceptRanges: "bytes",
      contentLength: 0,
      contentRange: `bytes */${Math.max(0, totalSize)}`,
    };
  }
  if (parsed.kind === "range") {
    return {
      status: 206,
      acceptRanges: "bytes",
      contentLength: parsed.length,
      contentRange: `bytes ${parsed.start}-${parsed.end}/${totalSize}`,
      range: { offset: parsed.start, length: parsed.length },
    };
  }
  return {
    status: 200,
    acceptRanges: "bytes",
    contentLength: totalSize,
  };
}
