import type { DSPStatus } from "@dsp-pipeline/shared";
import type { Request, Response } from "express";
import express, { Router } from "express";

import { getTrackStatus } from "../db.js";

export const sseClients = new Map<string, Set<Response>>();

const router: Router = Router();

function writeSseEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

router.get("/:trackId/status", (req: Request, res: Response) => {
  const trackId = req.params.trackId;
  if (!trackId) {
    return res.status(400).json({ error: "trackId is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // If behind a proxy like nginx
  res.setHeader("X-Accel-Buffering", "no");

  const currentStatuses = getTrackStatus(trackId) ?? [];
  writeSseEvent(res, "status", currentStatuses satisfies DSPStatus[]);

  const trackSet = sseClients.get(trackId) ?? new Set<Response>();
  trackSet.add(res);
  sseClients.set(trackId, trackSet);

  req.on("close", () => {
    const existing = sseClients.get(trackId);
    if (!existing) return;

    existing.delete(res);
    if (existing.size === 0) {
      sseClients.delete(trackId);
    }
  });
});

export default router;

