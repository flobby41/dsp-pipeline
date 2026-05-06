import type { DSPId, EncodeJob } from "@dsp-pipeline/shared";
import { Worker } from "bullmq";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function encodeFormat(format: DSPId, s3Key: string): Promise<void> {
  await sleep(800);
  // eslint-disable-next-line no-console
  console.log(`Encoded ${format} for ${s3Key}`);
}

const connection = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
};

const worker = new Worker<EncodeJob>(
  "track.process",
  async (job) => {
    const { trackId, s3Key } = job.data;

    await job.updateProgress(0);

    const filename = s3Key.split("/").at(-1) ?? "unknown";
    // eslint-disable-next-line no-console
    console.log(`Processing track ${trackId} — ${filename}`);

    await encodeFormat("spotify", s3Key);
    await job.updateProgress(33);

    await encodeFormat("apple", s3Key);
    await job.updateProgress(66);

    await encodeFormat("deezer", s3Key);
    await job.updateProgress(100);

    // eslint-disable-next-line no-console
    console.log(`Track ${trackId} ready for distribution`);
  },
  {
    connection,
    concurrency: 1,
  },
);

worker.on("failed", (job, error) => {
  const trackId = job?.data?.trackId ?? "unknown";
  // eslint-disable-next-line no-console
  console.error(`Job failed for trackId=${trackId}`, error);
});

worker.on("error", (error) => {
  // eslint-disable-next-line no-console
  console.error("Worker connection error", error);
});

