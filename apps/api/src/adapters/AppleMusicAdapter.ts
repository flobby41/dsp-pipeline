import type { DSPResult, Track } from "@dsp-pipeline/shared";

import { BaseDSPAdapter } from "./BaseDSPAdapter.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type TrackWithMetadata = Track & {
  isrc?: string;
  title?: string;
  artist?: string;
};

export class AppleMusicAdapter extends BaseDSPAdapter {
  dspId = "apple" as const;

  mapMetadata(track: Track): Record<string, unknown> {
    const { isrc, title, artist } = track as TrackWithMetadata;
    return {
      isrc,
      song_title: title,
      artist_name: artist,
      codec: "aac",
    };
  }

  async distribute(track: Track): Promise<DSPResult> {
    return this.withRetry(async () => {
      await sleep(200);
      // eslint-disable-next-line no-console
      console.log("POST apple/api/releases");
      return { dspId: this.dspId, success: true };
    });
  }
}

