import type { DSPId, DSPResult, Track } from "@dsp-pipeline/shared";

import { BaseDSPAdapter } from "./BaseDSPAdapter.js";

function stringifyUnknownError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

export class DSPRegistry {
  private readonly adaptersById = new Map<DSPId, BaseDSPAdapter>();

  register(adapter: BaseDSPAdapter): void {
    this.adaptersById.set(adapter.dspId, adapter);
  }

  get(dspId: DSPId): BaseDSPAdapter {
    const adapter = this.adaptersById.get(dspId);
    if (!adapter) {
      throw new Error(`DSP adapter not registered: ${dspId}`);
    }
    return adapter;
  }

  async distributeAll(track: Track): Promise<DSPResult[]> {
    const adapters = [...this.adaptersById.values()];
    const results = await Promise.allSettled(
      adapters.map(async (adapter) => adapter.distribute(track)),
    );

    return results.map((result, index) => {
      const adapter = adapters[index];
      if (!adapter) throw new Error("Adapter/result mismatch");

      if (result.status === "fulfilled") {
        return result.value;
      }

      return {
        dspId: adapter.dspId,
        success: false,
        error: stringifyUnknownError(result.reason),
      };
    });
  }
}

