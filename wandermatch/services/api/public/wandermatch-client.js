/**
 * WanderMatch API Client — Universal Browser & Module SDK
 * Connects frontend (index1.html) with WanderMatch Fastify API (/api/v1) and Socket.io.
 *
 * Capabilities:
 *  1. Automatic Itinerary Version Tracking (expectedVersion on writes + 409 conflict handling).
 *  2. Realtime WebSocket subscription (room-per-trip, echo suppression, live sync).
 *  3. Presigned direct-to-S3 photo uploading pipeline with bounded concurrency.
 *  4. Health check and configurable base URL with localStorage persistence.
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const exports = factory();
    root.WanderMatchClient = exports.WanderMatchClient;
    root.wm = exports.wm;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function getSavedBaseUrl() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const saved = window.localStorage.getItem('wm:apiUrl');
        if (saved && !saved.includes(':8080')) return saved.replace(/\/$/, '');
      }
      if (typeof window !== 'undefined' && window.WANDERMATCH_API) {
        return window.WANDERMATCH_API.replace(/\/$/, '');
      }
      if (typeof window !== 'undefined' && window.location && window.location.origin) {
        return window.location.origin;
      }
    } catch (_) {}
    return 'http://localhost:3000';
  }

  class WanderMatchClient {
    constructor(baseUrl) {
      this.baseUrl = (baseUrl || getSavedBaseUrl()).replace(/\/$/, '');
      this.token = this._getStorage('wm:token');
      this.userId = this._getStorage('wm:userId');
      this.currentUser = null;
      this.socket = null;
      this.tripId = null;

      // Current itinerary version contract
      this.itinerary = { id: null, version: null };

      this._handlers = new Map();
      this.onConflict = null;
      this.onStatusChange = null;
    }

    _getStorage(key) {
      try {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
      } catch (_) {
        return null;
      }
    }

    _setStorage(key, val) {
      try {
        if (typeof localStorage !== 'undefined') {
          if (val === null || val === undefined) localStorage.removeItem(key);
          else localStorage.setItem(key, val);
        }
      } catch (_) {}
    }

    setBaseUrl(url) {
      this.baseUrl = (url || 'http://localhost:8080').replace(/\/$/, '');
      this._setStorage('wm:apiUrl', this.baseUrl);
      if (this.socket) {
        this.disconnect();
      }
    }

    /* ---------------- Health & Diagnostics ---------------- */

    async checkHealth() {
      const start = Date.now();
      try {
        const res = await fetch(`${this.baseUrl}/health`, {
          method: 'GET',
          headers: { 'accept': 'application/json' }
        });
        const latencyMs = Date.now() - start;
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          return { ok: true, latencyMs, data };
        }
        return { ok: false, status: res.status, latencyMs };
      } catch (err) {
        return { ok: false, error: err.message, latencyMs: Date.now() - start };
      }
    }

    /* ---------------- HTTP Transport ---------------- */

    async _fetch(path, { method = 'GET', body, query } = {}) {
      const url = new URL(this.baseUrl + '/api/v1' + path);
      if (query) {
        for (const [k, v] of Object.entries(query)) {
          if (v != null) url.searchParams.set(k, String(v));
        }
      }

      const headers = {
        'content-type': 'application/json'
      };
      if (this.token) {
        headers['authorization'] = `Bearer ${this.token}`;
      }

      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });

      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (_) {
        data = { raw: text };
      }

      if (!res.ok) {
        const err = new Error(data.error?.message ?? `HTTP ${res.status}`);
        err.code = data.error?.code ?? 'UNKNOWN';
        err.status = res.status;
        err.details = data.error?.details;

        if (err.code === 'VERSION_CONFLICT') {
          this.itinerary.version = err.details?.currentVersion ?? this.itinerary.version;
          if (this.onConflict) {
            this.onConflict(err);
            if (this.tripId) {
              await this.getItinerary(this.tripId).catch(() => {});
            }
          }
        }
        throw err;
      }
      return data;
    }

    /* ---------------- Auth ---------------- */

    async signup(email, password, displayName, locale = 'en-IN') {
      const r = await this._fetch('/auth/signup', {
        method: 'POST',
        body: { email, password, displayName, locale }
      });
      this._storeSession(r);
      return r;
    }

    async login(email, password) {
      const r = await this._fetch('/auth/login', {
        method: 'POST',
        body: { email, password }
      });
      this._storeSession(r);
      return r;
    }

    _storeSession({ token, user }) {
      this.token = token;
      this.userId = user?.userId || null;
      this.currentUser = user || null;
      this._setStorage('wm:token', token);
      this._setStorage('wm:userId', user?.userId);
      this._setStorage('wm:user', JSON.stringify(user));
    }

    logout() {
      this.token = null;
      this.userId = null;
      this.currentUser = null;
      this._setStorage('wm:token', null);
      this._setStorage('wm:userId', null);
      this._setStorage('wm:user', null);
      this.disconnect();
    }

    async me() {
      const r = await this._fetch('/auth/me');
      if (r?.user) {
        this.currentUser = r.user;
        this._setStorage('wm:user', JSON.stringify(r.user));
      }
      return r;
    }

    getStoredUser() {
      if (this.currentUser) return this.currentUser;
      const raw = this._getStorage('wm:user');
      if (raw) {
        try {
          this.currentUser = JSON.parse(raw);
          return this.currentUser;
        } catch (_) {}
      }
      return null;
    }

    /* ---------------- Trips ---------------- */

    createTrip(payload) {
      return this._fetch('/trips', { method: 'POST', body: payload });
    }

    listTrips() {
      return this._fetch('/trips');
    }

    listMyTrips() {
      return this._fetch('/trips/mine');
    }

    getTrip(tripId) {
      return this._fetch(`/trips/${tripId}`);
    }

    inviteMember(tripId, userId, role = 'viewer', shareWeight = 1) {
      return this._fetch(`/trips/${tripId}/members`, {
        method: 'POST',
        body: { userId, role, shareWeight }
      });
    }

    setRole(tripId, userId, role) {
      return this._fetch(`/trips/${tripId}/members/${userId}/role`, {
        method: 'PUT',
        body: { role }
      });
    }

    archiveTrip(tripId) {
      return this._fetch(`/trips/${tripId}/archive`, { method: 'POST' });
    }

    /* ---------------- Itinerary ---------------- */

    async getItinerary(tripId) {
      const data = await this._fetch(`/trips/${tripId}/itinerary`);
      this.itinerary = { id: data.itinerary?.itinerary_id, version: data.version };
      this.tripId = tripId;
      return data;
    }

    async addItem(tripId, item) {
      const r = await this._fetch(`/trips/${tripId}/itinerary/items`, {
        method: 'POST',
        body: {
          itineraryId: this.itinerary.id,
          expectedVersion: this.itinerary.version,
          currency: 'INR',
          itemType: 'poi',
          ...item
        }
      });
      if (r.version != null) this.itinerary.version = r.version;
      return r;
    }

    async updateItem(tripId, itemId, changes) {
      const r = await this._fetch(`/trips/${tripId}/itinerary/items/${itemId}`, {
        method: 'PATCH',
        body: { expectedVersion: this.itinerary.version, ...changes }
      });
      if (r.version != null) this.itinerary.version = r.version;
      return r;
    }

    async deleteItem(tripId, itemId) {
      const r = await this._fetch(`/trips/${tripId}/itinerary/items/${itemId}`, {
        method: 'DELETE',
        query: { expectedVersion: this.itinerary.version }
      });
      if (r.version != null) this.itinerary.version = r.version;
      return r;
    }

    async reorder(tripId, moves) {
      const r = await this._fetch(`/trips/${tripId}/itinerary/reorder`, {
        method: 'POST',
        body: {
          itineraryId: this.itinerary.id,
          expectedVersion: this.itinerary.version,
          moves
        }
      });
      if (r.version != null) this.itinerary.version = r.version;
      return r;
    }

    /* ---------------- Proposals & Voting ---------------- */

    listGlobalProposals() {
      return this._fetch('/proposals');
    }

    proposeGlobal(proposal) {
      return this._fetch('/proposals', {
        method: 'POST',
        body: proposal
      });
    }

    voteGlobal(proposalId, value = 'yes', comment = null, voterName = 'you', remove = false) {
      return this._fetch(`/proposals/${proposalId}/vote`, {
        method: 'POST',
        body: { value, comment, voterName, remove }
      });
    }

    propose(tripId, proposal) {
      return this._fetch(`/trips/${tripId}/proposals`, {
        method: 'POST',
        body: {
          itineraryId: this.itinerary.id,
          currency: 'INR',
          ...proposal
        }
      });
    }

    listProposals(tripId, status = 'open') {
      return this._fetch(`/trips/${tripId}/proposals`, { query: { status } });
    }

    vote(tripId, proposalId, value, comment = null, weight = 1) {
      return this._fetch(`/trips/${tripId}/proposals/${proposalId}/vote`, {
        method: 'POST',
        body: { value, comment, weight }
      });
    }

    decideConsensus(tripId, recommendationId, decision, chosenProposalId = null) {
      return this._fetch(`/trips/${tripId}/consensus/${recommendationId}/decide`, {
        method: 'POST',
        body: { decision, chosenProposalId }
      });
    }

    /* ---------------- Matching ---------------- */

    findMatches(criteria) {
      return this._fetch('/matching/search', { method: 'POST', body: criteria });
    }

    requestToJoin(tripId, message, matchScoreId = null) {
      return this._fetch(`/trips/${tripId}/join-requests`, {
        method: 'POST',
        body: { message, matchScoreId }
      });
    }

    listJoinRequests(tripId) {
      return this._fetch(`/trips/${tripId}/join-requests`);
    }

    decideJoinRequest(tripId, requestId, decision, role = 'editor') {
      return this._fetch(`/trips/${tripId}/join-requests/${requestId}/decide`, {
        method: 'POST',
        body: { decision, role }
      });
    }

    /* ---------------- Photos & Face Grouping ---------------- */

    setFaceConsent(tripId, granted) {
      return this._fetch(`/trips/${tripId}/face-consent`, {
        method: 'PUT',
        body: { granted: Boolean(granted) }
      });
    }

    getFaceConsent(tripId) {
      return this._fetch(`/trips/${tripId}/face-consent`);
    }

    async uploadPhoto(tripId, file, { onProgress } = {}) {
      const presign = await this._fetch(`/trips/${tripId}/photos/presign`, {
        method: 'POST',
        body: { contentType: file.type || 'image/jpeg', byteSize: file.size }
      });

      if (presign.duplicate) {
        onProgress?.({ file, status: 'duplicate', photoId: presign.photoId });
        return presign;
      }

      onProgress?.({ file, status: 'uploading', photoId: presign.photoId });

      const put = await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'image/jpeg' },
        body: file
      });
      if (!put.ok) throw new Error(`Upload failed for ${file.name} (${put.status})`);

      const done = await this._fetch(`/trips/${tripId}/photos/${presign.photoId}/complete`, {
        method: 'POST'
      });
      onProgress?.({ file, status: 'done', photoId: presign.photoId, ...done });
      return done;
    }

    async uploadPhotos(tripId, files, { onProgress, concurrency = 3 } = {}) {
      const queue = [...files];
      const results = [];
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length) {
          const file = queue.shift();
          try {
            results.push(await this.uploadPhoto(tripId, file, { onProgress }));
          } catch (err) {
            onProgress?.({ file, status: 'failed', error: err.message });
            results.push({ error: err.message, file: file.name });
          }
        }
      });
      await Promise.all(workers);
      return results;
    }

    getFaceGroups(tripId) {
      return this._fetch(`/trips/${tripId}/face-groups`);
    }

    labelFaceGroup(tripId, faceGroupId, memberUserId, label = null) {
      return this._fetch(`/trips/${tripId}/face-groups/${faceGroupId}/label`, {
        method: 'PUT',
        body: { memberUserId, label }
      });
    }

    recluster(tripId) {
      return this._fetch(`/trips/${tripId}/face-groups/recluster`, { method: 'POST' });
    }

    /* ---------------- Reference Data ---------------- */

    searchCities(q = '') {
      return this._fetch('/reference/cities', { query: { q } });
    }

    listLanguages() {
      return this._fetch('/reference/languages');
    }

    listCurrencies() {
      return this._fetch('/reference/currencies');
    }

    listGuides(filters = {}) {
      return this._fetch('/reference/guides', { query: filters });
    }

    /* ---------------- Realtime Socket.io ---------------- */

    async connect(tripId) {
      if (typeof window === 'undefined' || !window.io) {
        console.warn('[WanderMatch] Socket.io client not available; realtime updates paused.');
        return null;
      }
      if (!this.token) {
        console.warn('[WanderMatch] Cannot connect socket: user not authenticated.');
        return null;
      }

      if (!this.socket) {
        this.socket = window.io(this.baseUrl, {
          auth: { token: this.token },
          transports: ['websocket', 'polling'],
          reconnection: true,
          reconnectionAttempts: 5
        });
      }

      await new Promise((resolve, reject) => {
        const done = res => {
          if (res?.ok) resolve(res);
          else reject(new Error(res?.error ?? 'subscribe failed'));
        };

        if (this.socket.connected) {
          this.socket.emit('trip:subscribe', tripId, done);
        } else {
          this.socket.once('connect', () => {
            this.socket.emit('trip:subscribe', tripId, done);
          });
          this.socket.once('connect_error', err => {
            reject(err);
          });
        }
      }).catch(err => {
        console.warn('[WanderMatch] Socket subscribe error:', err.message);
      });

      this.tripId = tripId;

      for (const [event, list] of this._handlers) {
        for (const entry of list) this._bind(event, entry);
      }
      return this.socket;
    }

    _bind(event, entry) {
      if (entry._bound || !this.socket) return;
      entry._bound = true;
      this.socket.on(event, payload => {
        if (!entry.opts.includeOwn && payload?.actorUserId === this.userId) return;
        if (payload?.version != null) this.itinerary.version = payload.version;
        try {
          entry.fn(payload);
        } catch (e) {
          console.error(`[WanderMatch] Error in listener for ${event}:`, e);
        }
      });
    }

    on(event, fn, opts = {}) {
      const entry = { fn, opts, _bound: false };
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(entry);
      if (this.socket) this._bind(event, entry);
      return () => {
        const list = this._handlers.get(event) ?? [];
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
      };
    }

    disconnect() {
      if (this.socket) {
        this.socket.disconnect();
        this.socket = null;
      }
      this.tripId = null;
      for (const list of this._handlers.values()) {
        for (const entry of list) entry._bound = false;
      }
    }
  }

  const defaultInstance = new WanderMatchClient();
  return {
    WanderMatchClient,
    wm: defaultInstance
  };
});
