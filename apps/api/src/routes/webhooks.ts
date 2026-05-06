import type { DSPId } from "@dsp-pipeline/shared";
import type { Request, Response } from "express";
import express, { Router } from "express";

import { updateDSPStatus } from "../db.js";
import { sseClients } from "./status.js";

const router: Router = Router();

type WebhookBody = {
  trackId: string;
  status: "live" | "failed";
  confirmedAt: string;
};

function isDSPId(value: string): value is DSPId {
  return value === "spotify" || value === "apple" || value === "deezer";
}

function emitSseStatus(trackId: string, payload: unknown): void {
  const clients = sseClients.get(trackId);
  if (!clients) return;

  const data = JSON.stringify(payload);
  for (const res of clients) {
    res.write("event: status\n");
    res.write(`data: ${data}\n\n`);
  }
}

router.post("/:dsp", express.json({ limit: "1mb" }), (req: Request, res: Response) => {
  const secret = process.env.DSP_WEBHOOK_SECRET ?? "";
  const signature = req.header("X-DSP-Signature") ?? "";

  if (!secret || signature !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const dsp = req.params["dsp"];
  if (!dsp) {
    res.status(400).json({ error: "Missing dsp param" });
    return;
  }
  if (!isDSPId(dsp)) {
    return res.status(400).json({ error: "Unknown DSP" });
  }

  const body = req.body as WebhookBody;
  if (!body?.trackId || typeof body.trackId !== "string") {
    return res.status(400).json({ error: "trackId is required" });
  }
  if (body.status !== "live" && body.status !== "failed") {
    return res.status(400).json({ error: "Invalid status" });
  }
  if (!body.confirmedAt || typeof body.confirmedAt !== "string") {
    return res.status(400).json({ error: "confirmedAt is required" });
  }

  const confirmedAt = new Date(body.confirmedAt);
  if (Number.isNaN(confirmedAt.getTime())) {
    return res.status(400).json({ error: "confirmedAt must be an ISO date string" });
  }

  updateDSPStatus(body.trackId, dsp, {
    status: body.status,
    confirmedAt,
  });

  emitSseStatus(body.trackId, {
    trackId: body.trackId,
    dspId: dsp,
    status: body.status,
    confirmedAt: confirmedAt.toISOString(),
  });

  return res.status(200).json({ ok: true });
});

export default router;

