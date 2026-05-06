import type { DSPId, DSPStatus } from "@dsp-pipeline/shared";

type TrackStatusEntry = {
  dspStatuses: DSPStatus[];
  updatedAt: Date;
};

const releasesByTrackId = new Map<string, TrackStatusEntry>();

export function initTrack(trackId: string, dsps: DSPId[]): void {
  const dspStatuses: DSPStatus[] = dsps.map((dspId) => ({
    dspId,
    trackId,
    status: "pending",
    retries: 0,
  }));

  releasesByTrackId.set(trackId, { dspStatuses, updatedAt: new Date() });
}

export function updateDSPStatus(
  trackId: string,
  dspId: DSPId,
  patch: Partial<DSPStatus>,
): void {
  const entry = releasesByTrackId.get(trackId);
  if (!entry) return;

  const next = entry.dspStatuses.map((current) => {
    if (current.dspId !== dspId) return current;
    return {
      ...current,
      ...patch,
      dspId: current.dspId,
      trackId: current.trackId,
    };
  });

  releasesByTrackId.set(trackId, { dspStatuses: next, updatedAt: new Date() });
}

export function getTrackStatus(trackId: string): DSPStatus[] | undefined {
  return releasesByTrackId.get(trackId)?.dspStatuses;
}

