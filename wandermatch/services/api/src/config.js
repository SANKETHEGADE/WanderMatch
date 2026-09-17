/** Central config. Fails fast on missing required values in production. */
const required = (key, fallback) => {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${key}`);
  return v;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3000').split(','),

  db: {
    connectionString: required('DATABASE_URL', 'postgres://wander:wander@localhost:5432/wandermatch'),
    max: Number(process.env.PG_POOL_MAX ?? 15),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statementTimeoutMs: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15_000)
  },

  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379'
  },

  jwt: {
    secret: required('JWT_SECRET', 'dev-only-change-me-in-production'),
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d'
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    timeoutMs: Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 20_000)
  },

  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: process.env.S3_BUCKET ?? 'wandermatch-photos',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    uploadUrlTtlSeconds: 900,
    maxPhotoBytes: Number(process.env.MAX_PHOTO_BYTES ?? 15 * 1024 * 1024)
  },

  face: {
    serviceUrl: process.env.FACE_SERVICE_URL ?? 'http://localhost:8001',
    timeoutMs: Number(process.env.FACE_TIMEOUT_MS ?? 60_000),
    enabled: process.env.FACE_ENABLED !== 'false'
  },

  limits: {
    globalPerMinute: Number(process.env.RATE_GLOBAL ?? 300),
    consensusPerHour: Number(process.env.RATE_CONSENSUS ?? 30)
  }
};
