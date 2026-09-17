/**
 * Thin client for the Python face service. Kept separate so the API has
 * exactly one place that knows that service's wire format — and so it can
 * be stubbed in tests without a model download.
 */
import { config } from '../config.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'faceClient' });

async function call(path, body, { timeoutMs = config.face.timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.face.serviceUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-token': process.env.FACE_SERVICE_TOKEN ?? ''
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`face service ${res.status}: ${text.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function analysePhoto({ tripId, photoId, imageUrl, imageBase64 }) {
  return call('/v1/photos/analyse', {
    trip_id: tripId,
    photo_id: photoId,
    image_url: imageUrl ?? null,
    image_base64: imageBase64 ?? null
  });
}

export function reclusterTrip(tripId, threshold) {
  return call('/v1/trips/recluster', {
    trip_id: tripId,
    ...(threshold ? { threshold } : {})
  });
}

export async function purgeTripIndex(tripId) {
  try {
    return await call('/v1/trips/purge', { trip_id: tripId }, { timeoutMs: 10_000 });
  } catch (err) {
    // Deliberately loud: a failed purge is a privacy commitment we did not
    // keep, so it must be visible in logs even though we do not block on it.
    log.error({ err, tripId }, 'FACE INDEX PURGE FAILED — manual cleanup required');
    throw err;
  }
}
