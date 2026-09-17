import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey
  },
  forcePathStyle: config.s3.forcePathStyle
});

export function presignUpload(key, contentType) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      ContentType: contentType,
      ServerSideEncryption: 'AES256'
    }),
    { expiresIn: config.s3.uploadUrlTtlSeconds }
  );
}

/**
 * Short TTL on reads: a collage URL that leaks from a screenshot or a log
 * should stop working quickly. 10 minutes is long enough to render a page
 * and short enough to be worth little if it escapes.
 */
export function presignDownload(key, expiresIn = 600) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    { expiresIn }
  );
}

export function deleteObject(key) {
  return s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
}
