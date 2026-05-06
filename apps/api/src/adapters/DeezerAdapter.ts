import type { DSPResult, Track } from "@dsp-pipeline/shared";

import { BaseDSPAdapter } from "./BaseDSPAdapter.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type TrackWithMetadata = Track & {
  isrc?: string;
  title?: string;
  artist?: string;
};

export class DeezerAdapter extends BaseDSPAdapter {
  dspId = "deezer" as const;

  mapMetadata(track: Track): Record<string, unknown> {
    const { isrc, title, artist } = track as TrackWithMetadata;
    return {
      isrc,
      name: title,
      author: artist,
      format: "flac",
    };
  }

  async distribute(track: Track): Promise<DSPResult> {
    return this.withRetry(async () => {
      await sleep(200);
      // eslint-disable-next-line no-console
      console.log("POST deezer/api/v2/tracks");
      return { dspId: this.dspId, success: true };
    });
  }
}

