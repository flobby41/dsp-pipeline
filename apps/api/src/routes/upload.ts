import type { EncodeJob } from "@dsp-pipeline/shared";
import { Queue } from "bullmq";
import express, { Router } from "express";
import { nanoid } from "nanoid";

import { initTrack } from "../db.js";
import { UploadService } from "../services/UploadService.js";

const router: Router = Router();

const trackProcessQueue = new Queue("track.process", {
  connection: {
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
  },
});

type InitUploadBody = {
  filename: string;
  sizeBytes: number;
};

router.post("/init", async (req, res) => {
  const body = req.body as InitUploadBody;

  if (!body?.filename || typeof body.filename !== "string") {
    return res.status(400).json({ error: "filename is required" });
  }
  if (typeof body.sizeBytes !== "number") {
    return res.status(400).json({ error: "sizeBytes must be a number" });
  }

  const uploadService = new UploadService();
  const result = await uploadService.initMultipart(body.filename, body.sizeBytes);

  return res.json({
    uploadId: result.uploadId,
    s3Key: result.s3Key,
    parts: result.parts,
  });
});

type CompleteUploadBody = {
  uploadId: string;
  s3Key: string;
  parts: { partNumber: number; eTag: string }[];
};

router.post("/complete", async (req, res) => {
  const body = req.body as CompleteUploadBody;

  if (!body?.uploadId || typeof body.uploadId !== "string") {
    return res.status(400).json({ error: "uploadId is required" });
  }
  if (!body?.s3Key || typeof body.s3Key !== "string") {
    return res.status(400).json({ error: "s3Key is required" });
  }
  if (!Array.isArray(body.parts) || body.parts.length === 0) {
    return res.status(400).json({ error: "parts must be a non-empty array" });
  }

  const uploadService = new UploadService();
  await uploadService.completeMultipart(body.uploadId, body.s3Key, body.parts);

  const trackId = nanoid();
  const payload: EncodeJob = {
    trackId,
    s3Key: body.s3Key,
    formats: ["spotify", "apple", "deezer"],
  };

  await trackProcessQueue.add("encode", payload, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  });

  initTrack(trackId, ["spotify", "apple", "deezer"]);

  return res.status(202).json({ trackId });
});

export default router;

