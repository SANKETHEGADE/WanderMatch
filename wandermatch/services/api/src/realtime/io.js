/**
 * Realtime layer: Socket.io over WebSocket, one room per trip, Redis
 * pub/sub adapter so horizontal scaling works without sticky broadcast.
 *
 * Design rule for this file: the socket is an OUTPUT channel only.
 * Clients never mutate state over the socket — every write goes through
 * the authenticated HTTP API, which then broadcasts. That means the
 * permission checks, the version check and the transaction all live in one
 * place, and a malicious socket frame cannot bypass them. The cost is one
 * extra round trip on write; the benefit is that "can this user do this?"
 * is answered by exactly one code path.
 */

import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import jwt from '@fastify/jwt';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { getMembership } from '../plugins/rbac.js';

const log = logger.child({ mod: 'realtime' });

export const EVENTS = Object.freeze({
  ITEM_CREATED: 'item:created',
  ITEM_UPDATED: 'item:updated',
  ITEM_DELETED: 'item:deleted',
  ITINERARY_VERSION: 'itinerary:version',
  PROPOSAL_CREATED: 'proposal:created',
  PROPOSAL_UPDATED: 'proposal:updated',
  PROPOSAL_RESOLVED: 'proposal:resolved',
  VOTE_CAST: 'vote:cast',
  CONSENSUS_READY: 'consensus:ready',
  CONSENSUS_DECIDED: 'consensus:decided',
  MEMBER_JOINED: 'member:joined',
  MEMBER_ROLE_CHANGED: 'member:role_changed',
  JOIN_REQUEST_CREATED: 'join_request:created',
  PHOTO_UPLOADED: 'photo:uploaded',
  PHOTO_PROCESSED: 'photo:processed',
  FACE_GROUPS_UPDATED: 'face_groups:updated',
  PRESENCE: 'presence:update'
});

let io = null;

export function tripRoom(tripId) {
  return `trip:${tripId}`;
}

export async function initRealtime(httpServer, fastify) {
  const pub = new Redis(config.redis.url, { maxRetriesPerRequest: null });
  const sub = pub.duplicate();

  io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, credentials: true },
    // Allow polling fallback: hackathon venue wifi blocks raw WS more often
    // than anyone expects, and a degraded connection beats a dead board.
    transports: ['websocket', 'polling'],
    pingInterval: 20_000,
    pingTimeout: 25_000
  });

  io.adapter(createAdapter(pub, sub));

  // Authenticate the socket itself, once, at connect time.
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ??
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('UNAUTHORIZED'));

      const payload = fastify.jwt.verify(token);
      socket.data.userId = payload.sub;
      socket.data.displayName = payload.name;
      return next();
    } catch (err) {
      log.warn({ err: err.message }, 'socket auth rejected');
      return next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', socket => {
    const { userId } = socket.data;
    log.debug({ userId, sid: socket.id }, 'socket connected');

    /**
     * Joining a room is the one thing a client may ask for over the socket,
     * and it is still authorised against trip_members — a user cannot
     * subscribe to a trip they are not on.
     */
    socket.on('trip:subscribe', async (tripId, ack) => {
      try {
        const membership = await getMembership(tripId, userId);
        if (!membership) {
          ack?.({ ok: false, error: 'FORBIDDEN' });
          return;
        }
        socket.join(tripRoom(tripId));
        socket.data.trips ??= new Set();
        socket.data.trips.add(tripId);

        ack?.({ ok: true, role: membership.role });

        // Lightweight presence: who else has this board open. Not persisted
        // anywhere — it is live state and dies with the connection, which
        // is the honest representation of what it means.
        const sockets = await io.in(tripRoom(tripId)).fetchSockets();
        const present = [...new Set(sockets.map(s => s.data.userId))];
        io.to(tripRoom(tripId)).emit(EVENTS.PRESENCE, { tripId, userIds: present });
      } catch (err) {
        log.error({ err }, 'subscribe failed');
        ack?.({ ok: false, error: 'INTERNAL' });
      }
    });

    socket.on('trip:unsubscribe', tripId => {
      socket.leave(tripRoom(tripId));
      socket.data.trips?.delete(tripId);
    });

    socket.on('disconnect', async () => {
      for (const tripId of socket.data.trips ?? []) {
        const sockets = await io.in(tripRoom(tripId)).fetchSockets();
        const present = [...new Set(sockets.map(s => s.data.userId))];
        io.to(tripRoom(tripId)).emit(EVENTS.PRESENCE, { tripId, userIds: present });
      }
      log.debug({ userId, sid: socket.id }, 'socket disconnected');
    });
  });

  return io;
}

/**
 * Broadcast to a trip room.
 *
 * `actorUserId` is always included so a client can ignore the echo of its
 * own optimistic update instead of re-rendering over the user's cursor.
 */
export function emitToTrip(tripId, event, payload, { actorUserId = null } = {}) {
  if (!io) {
    log.warn({ event }, 'emit before realtime init — dropped');
    return;
  }
  io.to(tripRoom(tripId)).emit(event, {
    ...payload,
    tripId,
    actorUserId,
    emittedAt: new Date().toISOString()
  });
}

export function getIo() {
  return io;
}
