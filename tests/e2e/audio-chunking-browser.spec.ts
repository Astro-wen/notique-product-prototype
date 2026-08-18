import { expect, test } from "@playwright/test";

test.describe("browser audio chunking", () => {
  test.skip(({ isMobile }) => isMobile, "One real Chromium conversion is sufficient.");

  test("inspects and converts a long WAV without calling an API", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/?view=simple");

    const result = await page.evaluate(async () => {
      const sampleRate = 16_000;
      const durationSeconds = 301;
      const sampleCount = sampleRate * durationSeconds;
      const bytes = new Uint8Array(44 + sampleCount * 2);
      const view = new DataView(bytes.buffer);
      const ascii = (offset: number, value: string) => {
        for (let index = 0; index < value.length; index += 1) {
          view.setUint8(offset + index, value.charCodeAt(index));
        }
      };
      ascii(0, "RIFF");
      view.setUint32(4, bytes.length - 8, true);
      ascii(8, "WAVE");
      ascii(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      ascii(36, "data");
      view.setUint32(40, sampleCount * 2, true);

      const source = new Blob([bytes], { type: "audio/wav" });
      const modulePath = "/app/audio-chunking.ts";
      const chunker = await import(/* @vite-ignore */ modulePath);
      const durationMs = await chunker.inspectAudioDurationMs(source);
      const plan = chunker.audioChunkPlan(durationMs);
      const first = await chunker.prepareAudioChunk(source, plan[0], "long-recording.wav");
      return {
        durationMs,
        plan: plan.map((item: { index: number; startMs: number; endMs: number }) => item),
        chunkType: first.blob.type,
        chunkBytes: first.blob.size,
        chunkName: first.filename,
      };
    });

    expect(result.durationMs).toBe(301_000);
    expect(result.plan).toEqual([
      { index: 0, startMs: 0, endMs: 180_000 },
      { index: 1, startMs: 175_000, endMs: 301_000 },
    ]);
    expect(result.chunkType).toBe("audio/wav");
    expect(result.chunkBytes).toBeGreaterThan(5_000_000);
    expect(result.chunkName).toBe("long-recording.part-001.wav");
  });
});
