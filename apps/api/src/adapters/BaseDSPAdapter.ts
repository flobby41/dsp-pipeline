import type { DSPId, DSPResult, Track } from "@dsp-pipeline/shared";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export abstract class BaseDSPAdapter {
  abstract dspId: DSPId;

  abstract mapMetadata(track: Track): Record<string, unknown>;

  abstract distribute(track: Track): Promise<DSPResult>;

  protected async withRetry(
    fn: () => Promise<DSPResult>,
    maxAttempts = 3,
  ): Promise<DSPResult> {
    const backoffMs = [1000, 2000, 4000];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch {
        const shouldRetry = attempt < maxAttempts;
        if (!shouldRetry) {
          return { dspId: this.dspId, success: false, error: "Max retries reached" };
        }

        const waitMs = backoffMs[attempt - 1] ?? backoffMs.at(-1) ?? 4000;
        await sleep(waitMs);
      }
    }

    return { dspId: this.dspId, success: false, error: "Max retries reached" };
  }
}

