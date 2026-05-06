export type DSPId = "spotify" | "apple" | "deezer";

export interface Track {
  id: string;
  uploadId: string; // S3 multipart UploadId
  filename: string;
  sizeBytes: number;
  status: "uploaded" | "encoding" | "distributing" | "live" | "failed";
  createdAt: Date;
}

export interface EncodeJob {
  trackId: string;
  s3Key: string;
  formats: DSPId[];
}

export interface DSPStatus {
  dspId: DSPId;
  trackId: string;
  status: "pending" | "sending" | "retrying" | "live" | "failed";
  retries: number;
  confirmedAt?: Date;
}

export interface DSPResult {
  dspId: DSPId;
  success: boolean;
  error?: string;
}

