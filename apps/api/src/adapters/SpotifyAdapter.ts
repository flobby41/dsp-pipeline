import type { DSPResult, Track } from "@dsp-pipeline/shared";

import { BaseDSPAdapter } from "./BaseDSPAdapter.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type TrackWithMetadata = Track & {
  isrc?: string;
  title?: string;
  artist?: string;
};

export class SpotifyAdapter extends BaseDSPAdapter {
  dspId = "spotify" as const;

  mapMetadata(track: Track): Record<string, unknown> {
    const { isrc, title, artist } = track as TrackWithMetadata;
    return {
      isrc,
      title,
      artist,
      audio_format: "mp3",
    };
  }

  async distribute(track: Track): Promise<DSPResult> {
    return this.withRetry(async () => {
      await sleep(200);
      // eslint-disable-next-line no-console
      console.log("POST spotify/api/v1/releases");

      if (Math.random() < 0.3) {
        throw new Error("Spotify transient failure");
      }

      return { dspId: this.dspId, success: true };
    });
  }
}

