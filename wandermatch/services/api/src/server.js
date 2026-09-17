import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';

import { config } from './config.js';
import { logger } from './lib/logger.js';
import { AppError } from './lib/errors.js';
import { healthcheck, closePool } from './db/pool.js';
import { initRealtime } from './realtime/io.js';

import authRoutes from './routes/auth.js';
import tripRoutes from './routes/trips.js';
import itineraryRoutes from './routes/itinerary.js';
import proposalRoutes from './routes/proposals.js';
import matchingRoutes from './routes/matching.js';
import photoRoutes from './routes/photos.js';
import referenceRoutes from './routes/reference.js';

const fastify = Fastify({
  loggerInstance: logger,
  trustProxy: true,
  // Photos go direct to object storage via presigned URLs, so the API
  // itself never needs a large body limit. Keeping it small is a cheap
  // defence against memory-exhaustion attempts.
  bodyLimit: 1_048_576
});

await fastify.register(sensible);
await fastify.register(cors, {
  origin: config.env === 'production' ? config.corsOrigins : true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
});
await fastify.register(jwt, {
  secret: config.jwt.secret,
  sign: { expiresIn: config.jwt.expiresIn }
});
await fastify.register(rateLimit, {
  max: config.limits.globalPerMinute,
  timeWindow: '1 minute',
  // Rate-limit per authenticated user where possible, falling back to IP.
  // Keying purely on IP would throttle a whole team sharing venue wifi —
  // which at a hackathon is everyone.
  keyGenerator: req => req.user?.sub ?? req.ip
});

/**
 * Global auth gate. Routes opt OUT with `config: { public: true }` rather
 * than opting in, so a new route is private by default — forgetting to add
 * auth is a much more common mistake than forgetting to remove it.
 */
fastify.addHook('onRequest', async (request, reply) => {
  if (request.routeOptions?.config?.public) return;
  if (request.method === 'OPTIONS') return;
  if (request.url === '/health' || request.url === '/ready') return;

  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' }
    });
  }
});

/** One error shape for the whole API, so the client branches on `code`. */
fastify.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(422).send({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Some fields are not valid.',
        details: error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
      }
    });
  }

  if (error instanceof AppError) {
    if (error.status >= 500) request.log.error({ err: error }, 'app error');
    return reply.code(error.status).send({
      error: { code: error.code, message: error.message, details: error.details }
    });
  }

  // Postgres constraint violations mapped to something a user can act on.
  if (error.code === '23505') {
    return reply.code(409).send({
      error: { code: 'DUPLICATE', message: 'That already exists.' }
    });
  }
  if (error.code === '23503') {
    return reply.code(422).send({
      error: { code: 'FK_VIOLATION', message: 'That references something which does not exist.' }
    });
  }
  if (error.code === '40P01') {
    return reply.code(409).send({
      error: { code: 'DEADLOCK', message: 'That collided with another edit. Try again.' }
    });
  }

  request.log.error({ err: error }, 'unhandled error');
  return reply.code(error.statusCode ?? 500).send({
    error: {
      code: 'INTERNAL',
      // Never leak an internal message to the client in production.
      message: config.env === 'production' ? 'Something went wrong.' : String(error.message)
    }
  });
});

fastify.get('/health', { config: { public: true } }, async () => ({ ok: true }));

fastify.get('/ready', { config: { public: true } }, async (request, reply) => {
  try {
    await healthcheck();
    return { ok: true, db: true };
  } catch (err) {
    return reply.code(503).send({ ok: false, db: false });
  }
});

await fastify.register(async api => {
  await api.register(authRoutes);
  await api.register(referenceRoutes);
  await api.register(tripRoutes);
  await api.register(itineraryRoutes);
  await api.register(proposalRoutes);
  await api.register(matchingRoutes);
  await api.register(photoRoutes);
}, { prefix: '/api/v1' });

await fastify.listen({ port: config.port, host: config.host });
await initRealtime(fastify.server, fastify);
logger.info({ port: config.port }, 'wandermatch api listening');

/**
 * Graceful shutdown. Closing the HTTP server first stops new requests,
 * then in-flight transactions get a chance to finish before the pool goes.
 * Without this, a deploy mid-transaction can leave a row lock held until
 * Postgres times it out — and that lock is on `itineraries`, which would
 * freeze an entire trip's board.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    logger.info({ signal }, 'shutting down');
    try {
      await fastify.close();
      await closePool();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  });
}
