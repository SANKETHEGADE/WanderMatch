/**
 * Trip photo collage and face grouping.
 *
 * CONSENT IS ENFORCED HERE, and only here. The face service will embed
 * whatever it is given — that is deliberate separation of concerns, and it
 * means this file is the single place where "did this person agree to
 * this?" is answered. Every path that could reach the face service passes
 * through `assertConsent`.
 *
 * Upload flow is presigned-direct-to-S3, not proxied through the API:
 *   1. POST /photos/presign   -> API creates the row + a signed PUT URL
 *   2. client PUTs bytes straight to object storage
 *   3. POST /photos/:id/complete -> API confirms, queues face analysis
 *
 * Proxying 15MB photos through Node would block the event loop that the
 * realtime board shares. This keeps big binary transfer away from it.
 */

import { z } from 'zod';
import { ulid } from 'ulid';
import { pool, withTransaction } from '../db/pool.js';
import { requirePermission } from '../plugins/rbac.js';
import { emitToTrip, EVENTS } from '../realtime/io.js';
import { presignUpload, presignDownload, deleteObject } from '../lib/s3.js';
import { analysePhoto, reclusterTrip, purgeTripIndex } from '../lib/faceClient.js';
import { config } from '../config.js';
import { ConsentRequiredError, NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ mod: 'photos' });

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

/**
 * The consent gate. Throws unless this specific member has granted
 * consent for this specific trip. Checked before analysis, never after.
 */
async function assertConsent(tripId, userId, client = pool) {
  const { rows } = await client.query(
    `SELECT granted FROM face_consents WHERE trip_id = $1 AND user_id = $2`,
    [tripId, userId]
  );
  if (!rows[0]?.granted) throw new ConsentRequiredError();
}

export default async function photoRoutes(fastify) {
  /* ---------------------------------------------------------------- */
  /* Consent                                                           */
  /* ---------------------------------------------------------------- */
  fastify.put(
    '/trips/:tripId/face-consent',
    { preHandler: requirePermission('face:consent') },
    async request => {
      const { granted } = z.object({ granted: z.boolean() }).parse(request.body);
      const { tripId } = request.params;
      const userId = request.user.sub;

      await withTransaction(async c => {
        await c.query(
          `INSERT INTO face_consents (consent_id, trip_id, user_id, granted, granted_at, revoked_at, updated_at)
           VALUES ($1,$2,$3,$4, CASE WHEN $4 THEN now() END, CASE WHEN NOT $4 THEN now() END, now())
           ON CONFLICT (trip_id, user_id)
           DO UPDATE SET granted = EXCLUDED.granted,
                         granted_at = CASE WHEN EXCLUDED.granted THEN now() ELSE face_consents.granted_at END,
                         revoked_at = CASE WHEN NOT EXCLUDED.granted THEN now() ELSE NULL END,
                         updated_at = now()`,
          [ulid(), tripId, userId, granted]
        );

        // Revocation is not just a flag flip. If this was the last member
        // with consent, the whole index must go — otherwise "I withdrew
        // consent" would leave the vectors sitting in storage, which is
        // exactly the thing the consent promise is about.
        if (!granted) {
          const remaining = await c.query(
            `SELECT COUNT(*)::int AS n FROM face_consents
              WHERE trip_id = $1 AND granted`,
            [tripId]
          );
          if (remaining.rows[0].n === 0) {
            await c.query(`DELETE FROM face_groups WHERE trip_id = $1`, [tripId]);
            await purgeTripIndex(tripId).catch(err =>
              log.error({ err, tripId }, 'index purge failed after last consent revoked')
            );
          }
        }
      });

      return { ok: true, granted };
    }
  );

  fastify.get(
    '/trips/:tripId/face-consent',
    { preHandler: requirePermission('trip:read') },
    async request => {
      const { rows } = await pool.query(
        `SELECT granted FROM face_consents WHERE trip_id = $1 AND user_id = $2`,
        [request.params.tripId, request.user.sub]
      );
      return { granted: rows[0]?.granted ?? false };
    }
  );

  /* ---------------------------------------------------------------- */
  /* Presigned upload                                                  */
  /* ---------------------------------------------------------------- */
  fastify.post(
    '/trips/:tripId/photos/presign',
    { preHandler: requirePermission('photo:upload') },
    async (request, reply) => {
      const body = z.object({
        contentType: z.string(),
        byteSize: z.number().int().positive(),
        capturedAt: z.string().datetime().nullable().optional(),
        perceptualHash: z.string().max(64).nullable().optional()
      }).parse(request.body);

      if (!ALLOWED_TYPES.has(body.contentType)) {
        throw new ValidationError(`Unsupported image type: ${body.contentType}`);
      }
      if (body.byteSize > config.s3.maxPhotoBytes) {
        throw new ValidationError(
          `Photo is larger than the ${Math.round(config.s3.maxPhotoBytes / 1024 / 1024)}MB limit.`
        );
      }

      const { tripId } = request.params;
      const userId = request.user.sub;
      const photoId = ulid();
      const ext = body.contentType.split('/')[1].replace('jpeg', 'jpg');
      const storageKey = `trips/${tripId}/photos/${photoId}.${ext}`;

      // Duplicate suppression: re-uploading the same photo (a very common
      // accident when several people share the same camera roll) should
      // not create a second row and a second round of face analysis.
      if (body.perceptualHash) {
        const dup = await pool.query(
          `SELECT photo_id FROM trip_photos
            WHERE trip_id = $1 AND perceptual_hash = $2 LIMIT 1`,
          [tripId, body.perceptualHash]
        );
        if (dup.rows.length > 0) {
          reply.code(200);
          return { duplicate: true, photoId: dup.rows[0].photo_id, uploadUrl: null };
        }
      }

      await pool.query(
        `INSERT INTO trip_photos (
           photo_id, trip_id, uploaded_by_user_id, storage_key, content_type,
           byte_size, captured_at, perceptual_hash, processing_status, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',now())`,
        [
          photoId, tripId, userId, storageKey, body.contentType,
          body.byteSize, body.capturedAt ?? null, body.perceptualHash ?? null
        ]
      );

      const uploadUrl = await presignUpload(storageKey, body.contentType);

      reply.code(201);
      return {
        photoId,
        storageKey,
        uploadUrl,
        expiresInSeconds: config.s3.uploadUrlTtlSeconds
      };
    }
  );

  /* ---------------------------------------------------------------- */
  /* Complete upload -> optionally analyse                             */
  /* ---------------------------------------------------------------- */
  fastify.post(
    '/trips/:tripId/photos/:photoId/complete',
    { preHandler: requirePermission('photo:upload') },
    async request => {
      const { tripId, photoId } = request.params;
      const userId = request.user.sub;

      const photo = await pool.query(
        `SELECT * FROM trip_photos WHERE photo_id = $1 AND trip_id = $2`,
        [photoId, tripId]
      );
      if (photo.rows.length === 0) throw new NotFoundError('photo', photoId);

      emitToTrip(tripId, EVENTS.PHOTO_UPLOADED, { photoId }, { actorUserId: userId });

      // No consent -> the photo is stored and shown in the collage, but no
      // face is ever detected in it. That is the honest behaviour: the
      // member gets their photos, just not the grouping feature.
      let consented = true;
      try {
        await assertConsent(tripId, userId);
      } catch {
        consented = false;
      }

      if (!consented || !config.face.enabled) {
        await pool.query(
          `UPDATE trip_photos SET processing_status = 'skipped' WHERE photo_id = $1`,
          [photoId]
        );
        return { ok: true, photoId, faceGrouping: 'skipped', reason: consented ? 'disabled' : 'no_consent' };
      }

      // Fire-and-forget: the uploader should not wait ~400ms/photo while
      // batch-uploading 80 photos. Progress arrives over the socket.
      queueMicrotask(() => processPhoto(tripId, photoId, userId).catch(err =>
        log.error({ err, photoId }, 'face analysis failed')
      ));

      return { ok: true, photoId, faceGrouping: 'queued' };
    }
  );

  /* ---------------------------------------------------------------- */
  /* Read the collage                                                  */
  /* ---------------------------------------------------------------- */
  fastify.get(
    '/trips/:tripId/face-groups',
    { preHandler: requirePermission('trip:read') },
    async request => {
      const { tripId } = request.params;

      const groups = await pool.query(
        `SELECT fg.face_group_id, fg.member_user_id, fg.label, fg.face_count,
                fg.photo_count, fg.cover_photo_id, fg.cover_bbox,
                u.display_name AS member_name,
                p.storage_key AS cover_key
           FROM face_groups fg
           LEFT JOIN users u ON u.user_id = fg.member_user_id
           LEFT JOIN trip_photos p ON p.photo_id = fg.cover_photo_id
          WHERE fg.trip_id = $1
          ORDER BY fg.photo_count DESC, fg.face_count DESC`,
        [tripId]
      );

      const result = [];
      for (const g of groups.rows) {
        const photos = await pool.query(
          `SELECT tp.photo_id, tp.storage_key, fgp.bbox, fgp.similarity
             FROM face_group_photos fgp
             JOIN trip_photos tp ON tp.photo_id = fgp.photo_id
            WHERE fgp.face_group_id = $1
            ORDER BY fgp.similarity DESC NULLS LAST
            LIMIT 60`,
          [g.face_group_id]
        );

        result.push({
          faceGroupId: g.face_group_id,
          memberUserId: g.member_user_id,
          memberName: g.member_name,
          label: g.label,
          faceCount: g.face_count,
          photoCount: g.photo_count,
          // Signed URLs, short-lived. Photos are never public objects.
          coverUrl: g.cover_key ? await presignDownload(g.cover_key) : null,
          coverBbox: g.cover_bbox,
          photos: await Promise.all(photos.rows.map(async p => ({
            photoId: p.photo_id,
            url: await presignDownload(p.storage_key),
            bbox: p.bbox,
            similarity: p.similarity
          })))
        });
      }

      return { faceGroups: result };
    }
  );

  /* ---------------------------------------------------------------- */
  /* Manual labelling — never automatic                                */
  /* ---------------------------------------------------------------- */
  fastify.put(
    '/trips/:tripId/face-groups/:faceGroupId/label',
    { preHandler: requirePermission('face:label') },
    async request => {
      const body = z.object({
        memberUserId: z.string().nullable().optional(),
        label: z.string().max(80).nullable().optional()
      }).parse(request.body);
      const { tripId, faceGroupId } = request.params;
      const userId = request.user.sub;

      if (body.memberUserId) {
        const member = await pool.query(
          `SELECT 1 FROM trip_members
            WHERE trip_id = $1 AND user_id = $2 AND status = 'active'`,
          [tripId, body.memberUserId]
        );
        if (member.rows.length === 0) {
          throw new ValidationError('You can only label a cluster with a member of this trip.');
        }
      }

      const { rows } = await pool.query(
        `UPDATE face_groups
            SET member_user_id = $1, label = $2,
                labelled_by_user_id = $3, labelled_at = now(), updated_at = now()
          WHERE face_group_id = $4 AND trip_id = $5
          RETURNING face_group_id, member_user_id, label`,
        [body.memberUserId ?? null, body.label ?? null, userId, faceGroupId, tripId]
      );
      if (rows.length === 0) throw new NotFoundError('face group', faceGroupId);

      emitToTrip(tripId, EVENTS.FACE_GROUPS_UPDATED, {
        faceGroupId, labelled: true
      }, { actorUserId: userId });

      return { faceGroup: rows[0] };
    }
  );

  /* ---------------------------------------------------------------- */
  /* Re-cluster, for when incremental assignment has drifted           */
  /* ---------------------------------------------------------------- */
  fastify.post(
    '/trips/:tripId/face-groups/recluster',
    { preHandler: requirePermission('face:label') },
    async request => {
      const { tripId } = request.params;
      await assertConsent(tripId, request.user.sub);

      const result = await reclusterTrip(tripId);
      await syncClustersToDb(tripId, result.clusters);

      emitToTrip(tripId, EVENTS.FACE_GROUPS_UPDATED, {
        reclustered: true,
        metrics: result.metrics
      }, { actorUserId: request.user.sub });

      // Metrics go back to the caller so clustering quality is observable
      // rather than asserted (design doc §8.3 QA).
      return { ok: true, clusters: result.clusters.length, metrics: result.metrics };
    }
  );

  fastify.delete(
    '/trips/:tripId/photos/:photoId',
    { preHandler: requirePermission('photo:delete') },
    async request => {
      const { tripId, photoId } = request.params;
      const photo = await pool.query(
        `SELECT storage_key FROM trip_photos WHERE photo_id = $1 AND trip_id = $2`,
        [photoId, tripId]
      );
      if (photo.rows.length === 0) throw new NotFoundError('photo', photoId);

      await pool.query(`DELETE FROM trip_photos WHERE photo_id = $1`, [photoId]);
      await deleteObject(photo.rows[0].storage_key).catch(err =>
        log.error({ err, photoId }, 'object delete failed')
      );

      return { ok: true };
    }
  );
}

/* ------------------------------------------------------------------ */
/* Background processing                                               */
/* ------------------------------------------------------------------ */

async function processPhoto(tripId, photoId, actorUserId) {
  await pool.query(
    `UPDATE trip_photos SET processing_status = 'processing' WHERE photo_id = $1`,
    [photoId]
  );

  try {
    const photo = await pool.query(
      `SELECT storage_key FROM trip_photos WHERE photo_id = $1`, [photoId]
    );
    const url = await presignDownload(photo.rows[0].storage_key);

    const result = await analysePhoto({ tripId, photoId, imageUrl: url });

    await withTransaction(async c => {
      for (const a of result.assignments) {
        // Upsert the cluster row. The face service owns cluster identity;
        // Postgres mirrors it so the UI can join to users and labels.
        await c.query(
          `INSERT INTO face_groups (
             face_group_id, trip_id, face_count, photo_count,
             cover_photo_id, cover_bbox, centroid_dim, created_at, updated_at
           ) VALUES ($1,$2,1,1,$3,$4::jsonb,512,now(),now())
           ON CONFLICT (face_group_id) DO UPDATE
             SET face_count = face_groups.face_count + 1,
                 updated_at = now()`,
          [a.cluster_id, tripId, photoId, JSON.stringify(a.bbox)]
        );

        await c.query(
          `INSERT INTO face_group_photos (face_group_id, photo_id, bbox, det_score, similarity)
           VALUES ($1,$2,$3::jsonb,$4,$5)
           ON CONFLICT DO NOTHING`,
          [a.cluster_id, photoId, JSON.stringify(a.bbox), a.det_score, a.similarity]
        );

        await c.query(
          `UPDATE face_groups fg
              SET photo_count = (
                SELECT COUNT(DISTINCT photo_id) FROM face_group_photos
                 WHERE face_group_id = fg.face_group_id
              )
            WHERE fg.face_group_id = $1`,
          [a.cluster_id]
        );
      }

      await c.query(
        `UPDATE trip_photos
            SET processing_status = 'done', faces_detected = $1,
                width = $2, height = $3
          WHERE photo_id = $4`,
        [result.faces_detected, result.meta?.width ?? null, result.meta?.height ?? null, photoId]
      );
    });

    emitToTrip(tripId, EVENTS.PHOTO_PROCESSED, {
      photoId,
      facesDetected: result.faces_detected,
      clusters: result.clusters_total
    }, { actorUserId });
  } catch (err) {
    await pool.query(
      `UPDATE trip_photos
          SET processing_status = 'failed', processing_error = $1
        WHERE photo_id = $2`,
      [String(err.message ?? err).slice(0, 500), photoId]
    );
    emitToTrip(tripId, EVENTS.PHOTO_PROCESSED, {
      photoId, failed: true, error: 'Face analysis failed for this photo.'
    }, { actorUserId });
    throw err;
  }
}

/** Mirror a full re-cluster back into Postgres, preserving human labels. */
async function syncClustersToDb(tripId, clusters) {
  await withTransaction(async c => {
    // Labels are the one thing a re-cluster must not destroy — a member
    // who named their own cluster should not have to do it again.
    const labels = await c.query(
      `SELECT face_group_id, member_user_id, label, labelled_by_user_id, labelled_at
         FROM face_groups WHERE trip_id = $1 AND (member_user_id IS NOT NULL OR label IS NOT NULL)`,
      [tripId]
    );
    const priorLabels = new Map(labels.rows.map(r => [r.face_group_id, r]));

    await c.query(`DELETE FROM face_groups WHERE trip_id = $1`, [tripId]);

    for (const cl of clusters) {
      const prior = priorLabels.get(cl.cluster_id);
      await c.query(
        `INSERT INTO face_groups (
           face_group_id, trip_id, member_user_id, label, face_count, photo_count,
           cover_photo_id, cover_bbox, centroid, centroid_dim,
           labelled_by_user_id, labelled_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,now(),now())`,
        [
          cl.cluster_id, tripId,
          prior?.member_user_id ?? null, prior?.label ?? null,
          cl.face_count, cl.photo_ids.length,
          cl.cover?.photo_id ?? null, JSON.stringify(cl.cover?.bbox ?? {}),
          cl.centroid, cl.centroid?.length ?? 512,
          prior?.labelled_by_user_id ?? null, prior?.labelled_at ?? null
        ]
      );

      for (const photoId of cl.photo_ids) {
        await c.query(
          `INSERT INTO face_group_photos (face_group_id, photo_id, bbox, similarity)
           VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`,
          [cl.cluster_id, photoId, JSON.stringify(cl.cover?.bbox ?? {}), cl.cohesion]
        );
      }
    }
  });
}
