import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { nanoid } from "nanoid";

const PART_SIZE_BYTES = 10 * 1024 * 1024;

type PresignedPart = {
  partNumber: number;
  presignedUrl: string;
};

type CompletedPartInput = {
  partNumber: number;
  eTag: string;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function buildRawS3Key(filename: string): string {
  const safeFilename = filename.replaceAll("/", "_");
  return `raw/${nanoid()}/${safeFilename}`;
}

function getPartCount(sizeBytes: number): number {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error("sizeBytes must be a positive number");
  }
  return Math.ceil(sizeBytes / PART_SIZE_BYTES);
}

export class UploadService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor() {
    const region = getRequiredEnv("AWS_REGION");
    this.bucket = getRequiredEnv("AWS_BUCKET");

    this.s3 = new S3Client({
      region,
      credentials: {
        accessKeyId: getRequiredEnv("AWS_ACCESS_KEY_ID"),
        secretAccessKey: getRequiredEnv("AWS_SECRET_ACCESS_KEY"),
      },
    });
  }

  async initMultipart(
    filename: string,
    sizeBytes: number,
  ): Promise<{ uploadId: string; s3Key: string; parts: PresignedPart[] }> {
    const s3Key = buildRawS3Key(filename);

    const createResponse = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: s3Key,
        ContentType: "application/octet-stream",
      }),
    );

    const uploadId = createResponse.UploadId;
    if (!uploadId) {
      throw new Error("S3 did not return an uploadId");
    }

    const partCount = getPartCount(sizeBytes);
    const parts: PresignedPart[] = [];

    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const presignedUrl = await getSignedUrl(
        this.s3,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: s3Key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: 60 * 15 },
      );

      parts.push({ partNumber, presignedUrl });
    }

    return { uploadId, s3Key, parts };
  }

  async completeMultipart(
    uploadId: string,
    s3Key: string,
    parts: CompletedPartInput[],
  ): Promise<void> {
    const completedParts: CompletedPart[] = parts
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((part) => ({
        ETag: part.eTag,
        PartNumber: part.partNumber,
      }));

    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: s3Key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completedParts },
      }),
    );
  }
}

