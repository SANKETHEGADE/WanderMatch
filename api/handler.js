const crypto = require('crypto');

// ─── Persistent storage via Vercel KV (Redis) ───────────────────────────────
// Falls back to in-memory if KV env vars are not set (local dev).
// Set up KV: vercel.com → Storage → Create KV → Link to project.
// Env vars needed: KV_REST_API_URL, KV_REST_API_TOKEN (auto-injected by Vercel)
// ─────────────────────────────────────────────────────────────────────────────

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const USE_KV   = !!(KV_URL && KV_TOKEN);

// In-memory fallback (local dev / no KV configured)
const mem = { users: {}, sessions: {}, trips: {}, itineraries: {}, proposals: {} };

async function kvGet(key) {
  if (!USE_KV) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    if (!r.ok) return null;
    const { result } = await r.json();
    if (result === null || result === undefined) return null;
    return typeof result === 'string' ? JSON.parse(result) : result;
  } catch { return null; }
}

async function kvSet(key, value) {
  if (!USE_KV) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(value) })
    });
  } catch {}
}

// Append an id to a KV "index" list (e.g. user's trips)
async function kvListAdd(listKey, id) {
  const existing = await kvGet(listKey) || [];
  if (!existing.includes(id)) {
    existing.push(id);
    await kvSet(listKey, existing);
  }
}

async function kvListGet(listKey) {
  return await kvGet(listKey) || [];
}

// ─── Storage helpers (KV-backed with in-memory fallback) ─────────────────────

async function getUser(email) {
  if (USE_KV) return kvGet('user:' + email);
  return mem.users[email] || null;
}
async function setUser(email, user) {
  if (USE_KV) return kvSet('user:' + email, user);
  mem.users[email] = user;
}

async function getSession(token) {
  if (USE_KV) return kvGet('session:' + token);
  return mem.sessions[token] || null;
}
async function setSession(token, userId) {
  if (USE_KV) return kvSet('session:' + token, userId);
  mem.sessions[token] = userId;
}

async function getTrip(tripId) {
  if (USE_KV) return kvGet('trip:' + tripId);
  return mem.trips[tripId] || null;
}
async function setTrip(tripId, trip) {
  if (USE_KV) return kvSet('trip:' + tripId, trip);
  mem.trips[tripId] = trip;
}

async function getUserTrips(userId) {
  if (USE_KV) {
    const ids = await kvListGet('usertrips:' + userId);
    const trips = await Promise.all(ids.map(id => kvGet('trip:' + id)));
    return trips.filter(Boolean);
  }
  return Object.values(mem.trips).filter(t =>
    t.ownerId === userId || (t.members || []).some(m => m.userId === userId)
  );
}

async function addTripToUser(userId, tripId) {
  if (USE_KV) return kvListAdd('usertrips:' + userId, tripId);
  // mem fallback: no-op, getUserTrips scans all
}

async function getAllPublicTrips() {
  if (USE_KV) {
    const ids = await kvListGet('publictrips');
    const trips = await Promise.all(ids.map(id => kvGet('trip:' + id)));
    return trips.filter(Boolean);
  }
  return Object.values(mem.trips).filter(t => t.isPublic);
}

async function addPublicTrip(tripId) {
  if (USE_KV) return kvListAdd('publictrips', tripId);
}

async function getItinerary(tripId) {
  if (USE_KV) return kvGet('itin:' + tripId);
  return mem.itineraries[tripId] || null;
}
async function setItinerary(tripId, itin) {
  if (USE_KV) return kvSet('itin:' + tripId, itin);
  mem.itineraries[tripId] = itin;
}

async function getProposals(tripId) {
  if (USE_KV) return kvGet('proposals:' + tripId) || [];
  return mem.proposals[tripId] || [];
}
async function setProposals(tripId, list) {
  if (USE_KV) return kvSet('proposals:' + tripId, list);
  mem.proposals[tripId] = list;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getAuthUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const userId = await getSession(token);
  if (!userId) return null;
  // scan users for matching id (small scale)
  if (USE_KV) {
    // userId is stored directly
    return { id: userId, userId };
  }
  for (const u of Object.values(mem.users)) {
    if (u.id === userId) return u;
  }
  return { id: userId, userId };
}

function sendJson(res, statusCode, data) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match, Accept');
  res.setHeader('Content-Type', 'application/json; charset=UTF-8');
  res.status(statusCode).json(data);
}

// Real destination search using Open-Meteo geocoding (free, no key)
async function searchDestinations(query) {
  if (!query || query.length < 2) return [];
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=en&format=json`;
    const r = await fetch(url);
    if (!r.ok) return fallbackCities(query);
    const data = await r.json();
    if (!data.results || !data.results.length) return fallbackCities(query);
    return data.results.map(c => ({
      id: 'city_' + c.id,
      name: c.name,
      country: c.country,
      region: c.admin1 || '',
      displayName: c.admin1 ? `${c.name}, ${c.admin1}, ${c.country}` : `${c.name}, ${c.country}`,
      coordinates: [c.latitude, c.longitude],
      timezone: c.timezone,
      population: c.population
    }));
  } catch {
    return fallbackCities(query);
  }
}

function fallbackCities(q) {
  const all = [
    { id: 'city_manali', name: 'Manali', country: 'India', region: 'Himachal Pradesh', displayName: 'Manali, Himachal Pradesh, India', coordinates: [32.2396, 77.1887] },
    { id: 'city_gokarna', name: 'Gokarna', country: 'India', region: 'Karnataka', displayName: 'Gokarna, Karnataka, India', coordinates: [14.5479, 74.3188] },
    { id: 'city_jaisalmer', name: 'Jaisalmer', country: 'India', region: 'Rajasthan', displayName: 'Jaisalmer, Rajasthan, India', coordinates: [26.9157, 70.9083] },
    { id: 'city_coorg', name: 'Coorg', country: 'India', region: 'Karnataka', displayName: 'Coorg, Karnataka, India', coordinates: [12.3375, 75.8069] },
    { id: 'city_leh', name: 'Leh', country: 'India', region: 'Ladakh', displayName: 'Leh, Ladakh, India', coordinates: [34.1526, 77.5771] },
    { id: 'city_munnar', name: 'Munnar', country: 'India', region: 'Kerala', displayName: 'Munnar, Kerala, India', coordinates: [10.0889, 77.0595] },
    { id: 'city_rishikesh', name: 'Rishikesh', country: 'India', region: 'Uttarakhand', displayName: 'Rishikesh, Uttarakhand, India', coordinates: [30.0869, 78.2676] },
    { id: 'city_kyoto', name: 'Kyoto', country: 'Japan', region: '', displayName: 'Kyoto, Japan', coordinates: [35.0116, 135.7681] },
    { id: 'city_paris', name: 'Paris', country: 'France', region: '', displayName: 'Paris, France', coordinates: [48.8566, 2.3522] },
    { id: 'city_bali', name: 'Bali', country: 'Indonesia', region: '', displayName: 'Bali, Indonesia', coordinates: [-8.3405, 115.0920] },
    { id: 'city_rome', name: 'Rome', country: 'Italy', region: '', displayName: 'Rome, Italy', coordinates: [41.9028, 12.4964] },
  ];
  const ql = (q || '').toLowerCase();
  return all.filter(c =>
    c.name.toLowerCase().includes(ql) ||
    c.country.toLowerCase().includes(ql) ||
    (c.region || '').toLowerCase().includes(ql)
  );
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match, Accept');
    return res.status(204).end();
  }

  let pathname = req.url.split('?')[0];
  if (pathname.startsWith('/api/v1/')) pathname = pathname.substring(7);
  else if (pathname.startsWith('/api/')) pathname = pathname.substring(4);

  const body = req.body || {};
  const query = req.query || {};

  // ── 1. Health ──────────────────────────────────────────────────────────────
  if (pathname === '/health' || pathname === '/handler') {
    return sendJson(res, 200, {
      status: 'ok', service: 'wandermatch-api',
      storage: USE_KV ? 'vercel-kv' : 'in-memory',
      version: '2.0.0', timestamp: new Date().toISOString()
    });
  }

  // ── 2. Destination Search (real geocoding) ─────────────────────────────────
  if ((pathname === '/destinations/search' || pathname === '/reference/cities') && req.method === 'GET') {
    const q = query.q || query.query || '';
    const results = await searchDestinations(q);
    return sendJson(res, 200, { cities: results, results });
  }

  // ── 3. Auth ────────────────────────────────────────────────────────────────
  if (pathname === '/auth/signup' && req.method === 'POST') {
    if (!body.email || !body.password)
      return sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Email and password required' } });
    if (body.password.length < 6)
      return sendJson(res, 422, { error: { code: 'VALIDATION_FAILED', message: 'Password must be at least 6 characters' } });

    const existing = await getUser(body.email);
    if (existing)
      return sendJson(res, 409, { error: { code: 'EMAIL_TAKEN', message: 'An account with this email already exists. Please log in.' } });

    const userId = 'usr_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const user = {
      id: userId, userId, email: body.email,
      name: body.displayName || body.name || body.email.split('@')[0],
      displayName: body.displayName || body.name || body.email.split('@')[0],
      locale: body.locale || 'en', createdAt: new Date().toISOString(),
      // Store hashed password (simple SHA-256 for demo — use bcrypt in production)
      passwordHash: crypto.createHash('sha256').update(body.password + userId).digest('hex')
    };
    await setUser(body.email, user);
    const token = 'wmt_' + crypto.randomBytes(32).toString('hex');
    await setSession(token, userId);
    const { passwordHash, ...safeUser } = user;
    return sendJson(res, 201, { token, user: safeUser });
  }

  if (pathname === '/auth/login' && req.method === 'POST') {
    if (!body.email)
      return sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Email required' } });

    let user = await getUser(body.email);
    if (!user) {
      // Auto-create on first login (demo-friendly)
      const userId = 'usr_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      user = {
        id: userId, userId, email: body.email,
        name: body.displayName || body.name || body.email.split('@')[0],
        displayName: body.displayName || body.name || body.email.split('@')[0],
        locale: 'en', createdAt: new Date().toISOString()
      };
      await setUser(body.email, user);
    }
    // If passwordHash exists and password provided, verify it
    if (user.passwordHash && body.password) {
      const hash = crypto.createHash('sha256').update(body.password + user.id).digest('hex');
      if (hash !== user.passwordHash)
        return sendJson(res, 401, { error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect password' } });
    }
    const token = 'wmt_' + crypto.randomBytes(32).toString('hex');
    await setSession(token, user.id);
    const { passwordHash, ...safeUser } = user;
    return sendJson(res, 200, { token, user: safeUser });
  }

  if (pathname === '/auth/me' && req.method === 'GET') {
    const auth = await getAuthUser(req);
    if (!auth) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Not logged in' } });
    const user = await getUser(Object.keys(mem.users).find(k => mem.users[k]?.id === auth.id) || '') || auth;
    const { passwordHash, ...safeUser } = user;
    return sendJson(res, 200, { user: safeUser });
  }

  // ── 4. Trips ───────────────────────────────────────────────────────────────
  if (pathname === '/trips' && req.method === 'POST') {
    const auth = await getAuthUser(req);
    const userId = auth?.id || 'usr_guest';
    const tripId = 'trip_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const isPublic = body.isPublic !== false; // default public so friends can find it
    const newTrip = {
      id: tripId, tripId,
      title: body.title || body.name || 'Untitled Adventure',
      destination: body.destination || '',
      startDate: body.startDate || '',
      endDate: body.endDate || '',
      ownerId: userId,
      role: 'owner',
      isPublic,
      createdAt: new Date().toISOString(),
      members: [{ userId, role: 'owner', name: body.creatorName || 'Trip Creator', shareWeight: 1 }]
    };
    await setTrip(tripId, newTrip);
    await addTripToUser(userId, tripId);
    if (isPublic) await addPublicTrip(tripId);
    await setItinerary(tripId, { tripId, version: 1, items: [] });
    await setProposals(tripId, []);
    return sendJson(res, 201, { trip: newTrip });
  }

  // Get my trips
  if (pathname === '/trips/mine' && req.method === 'GET') {
    const auth = await getAuthUser(req);
    if (!auth) return sendJson(res, 200, { trips: [] });
    const trips = await getUserTrips(auth.id);
    return sendJson(res, 200, { trips });
  }

  // Get all trips (for browsing / joining)
  if (pathname === '/trips' && req.method === 'GET') {
    const dest = (query.destination || query.q || '').toLowerCase();
    let trips = await getAllPublicTrips();
    if (dest) {
      trips = trips.filter(t =>
        t.destination?.toLowerCase().includes(dest) ||
        t.title?.toLowerCase().includes(dest)
      );
    }
    return sendJson(res, 200, { trips });
  }

  // Search trips by destination or name (for "find a group")
  if (pathname === '/trips/search' && req.method === 'GET') {
    const q = (query.q || query.destination || '').toLowerCase();
    const trips = await getAllPublicTrips();
    const results = q
      ? trips.filter(t =>
          t.destination?.toLowerCase().includes(q) ||
          t.title?.toLowerCase().includes(q)
        )
      : trips;
    return sendJson(res, 200, { trips: results });
  }

  // ── 5. Itinerary ───────────────────────────────────────────────────────────
  const tripItinMatch = pathname.match(/^\/trips\/([^/]+)\/itinerary$/);
  if (tripItinMatch && req.method === 'GET') {
    const tripId = tripItinMatch[1];
    const itin = await getItinerary(tripId) || { tripId, version: 1, items: [] };
    return sendJson(res, 200, itin);
  }

  const tripItemsMatch = pathname.match(/^\/trips\/([^/]+)\/itinerary\/items$/);
  if (tripItemsMatch && req.method === 'POST') {
    const tripId = tripItemsMatch[1];
    const itin = await getItinerary(tripId) || { tripId, version: 1, items: [] };
    const newItem = {
      id: 'item_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8),
      dayIndex: body.dayIndex ?? 0,
      time: body.time || '10:00',
      title: body.title || 'New Activity',
      category: body.category || 'activity',
      notes: body.notes || ''
    };
    itin.items.push(newItem);
    itin.version += 1;
    await setItinerary(tripId, itin);
    return sendJson(res, 201, { item: newItem, version: itin.version });
  }

  const tripItemMatch = pathname.match(/^\/trips\/([^/]+)\/itinerary\/items\/([^/]+)$/);
  if (tripItemMatch) {
    const [, tripId, itemId] = tripItemMatch;
    const itin = await getItinerary(tripId) || { tripId, version: 1, items: [] };

    if (req.method === 'PUT' || req.method === 'PATCH') {
      const ifMatch = req.headers['if-match'];
      if (ifMatch && parseInt(ifMatch, 10) !== itin.version) {
        return sendJson(res, 409, { error: { code: 'VERSION_CONFLICT', message: 'Concurrent edit detected. Please reload.', currentVersion: itin.version } });
      }
      const idx = itin.items.findIndex(i => i.id === itemId);
      if (idx >= 0) itin.items[idx] = { ...itin.items[idx], ...body };
      else itin.items.push({ id: itemId, ...body });
      itin.version += 1;
      await setItinerary(tripId, itin);
      return sendJson(res, 200, { item: itin.items[idx >= 0 ? idx : itin.items.length - 1], version: itin.version });
    }
    if (req.method === 'DELETE') {
      itin.items = itin.items.filter(i => i.id !== itemId);
      itin.version += 1;
      await setItinerary(tripId, itin);
      return sendJson(res, 200, { success: true, version: itin.version });
    }
  }

  // ── 6. Proposals & Voting ──────────────────────────────────────────────────
  const propMatch = pathname.match(/^\/trips\/([^/]+)\/proposals$/);
  if (propMatch) {
    const tripId = propMatch[1];
    if (req.method === 'GET') {
      return sendJson(res, 200, { proposals: await getProposals(tripId) });
    }
    if (req.method === 'POST') {
      const auth = await getAuthUser(req);
      const propId = 'prop_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
      const newProp = {
        id: propId, proposal_id: propId, tripId,
        title: body.title || 'New Proposal',
        destination: body.destination || body.title || '',
        rationale: body.rationale || '',
        proposedBy: auth?.id || 'guest',
        votes: {}, tally: { yes: 0, no: 0, abstain: 0 },
        status: 'open',
        createdAt: new Date().toISOString()
      };
      const list = await getProposals(tripId);
      list.push(newProp);
      await setProposals(tripId, list);
      return sendJson(res, 201, { proposal: newProp });
    }
  }

  const voteMatch = pathname.match(/^\/trips\/([^/]+)\/proposals\/([^/]+)\/votes?$/);
  if (voteMatch && req.method === 'POST') {
    const [, tripId, propId] = voteMatch;
    const auth = await getAuthUser(req);
    const userId = auth?.id || 'guest';
    const list = await getProposals(tripId);
    const prop = list.find(p => p.id === propId);
    if (!prop) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Proposal not found' } });
    const value = body.value || body.vote || 'yes';
    if (!prop.votes) prop.votes = {};
    if (!prop.tally) prop.tally = { yes: 0, no: 0, abstain: 0 };
    // Remove old vote if switching
    const oldVote = prop.votes[userId];
    if (oldVote && prop.tally[oldVote] > 0) prop.tally[oldVote]--;
    prop.votes[userId] = value;
    prop.tally[value] = (prop.tally[value] || 0) + 1;
    await setProposals(tripId, list);
    const outcome = prop.tally.yes > prop.tally.no ? 'accepted' : prop.tally.no > prop.tally.yes ? 'rejected' : 'tied';
    return sendJson(res, 200, { outcome, vote: { proposalId: propId, userId, value }, tally: prop.tally });
  }

  const consensusMatch = pathname.match(/^\/trips\/([^/]+)\/proposals\/(consensus|[^/]+\/consensus)$/);
  if (consensusMatch && req.method === 'GET') {
    const tripId = consensusMatch[1];
    const proposals = await getProposals(tripId);
    // Find winning proposal by votes
    const ranked = proposals
      .filter(p => p.tally)
      .sort((a, b) => (b.tally.yes || 0) - (a.tally.yes || 0));
    const winner = ranked[0];
    const outcome = winner && winner.tally.yes > winner.tally.no ? 'accepted' : 'tied';
    return sendJson(res, 200, {
      outcome,
      consensus: {
        strategy: 'majority',
        recommendation: winner ? `The group favors: ${winner.title}` : 'No clear winner yet — keep voting!',
        rationale: winner ? `${winner.tally?.yes || 0} yes vs ${winner.tally?.no || 0} no votes` : 'Voting in progress',
        groundingPassed: true,
        isFallback: !winner
      }
    });
  }

  // ── 7. Single Trip & Members ───────────────────────────────────────────────
  const tripSingleMatch = pathname.match(/^\/trips\/([^/]+)$/);
  if (tripSingleMatch && req.method === 'GET') {
    const tripId = tripSingleMatch[1];
    const trip = await getTrip(tripId);
    if (!trip) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Trip not found' } });
    return sendJson(res, 200, { trip });
  }

  // ── 8. Join Trip ───────────────────────────────────────────────────────────
  const joinMatch = pathname.match(/^\/trips\/([^/]+)\/join-requests$/);
  if (joinMatch && req.method === 'POST') {
    const tripId = joinMatch[1];
    const auth = await getAuthUser(req);
    const userId = auth?.id || 'usr_guest_' + crypto.randomUUID().slice(0, 6);
    const trip = await getTrip(tripId);
    if (!trip) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Trip not found' } });
    // Auto-approve join request (add as member)
    if (!trip.members.some(m => m.userId === userId)) {
      trip.members.push({ userId, role: 'member', name: body.name || 'New Member', shareWeight: 1, joinedAt: new Date().toISOString() });
      await setTrip(tripId, trip);
      await addTripToUser(userId, tripId);
    }
    const reqId = 'req_' + crypto.randomUUID().slice(0, 8);
    return sendJson(res, 201, { requestId: reqId, status: 'approved', trip });
  }

  // ── 9. Matching / Find a Group ────────────────────────────────────────────
  if ((pathname === '/matching/search' || pathname === '/matching') && req.method === 'POST') {
    const dest = (body.destination || '').toLowerCase();
    const trips = await getAllPublicTrips();
    const matches = trips
      .filter(t => !dest || t.destination?.toLowerCase().includes(dest))
      .slice(0, 10)
      .map(t => ({
        tripId: t.id,
        title: t.title,
        destination: t.destination,
        dates: t.startDate && t.endDate ? `${t.startDate} → ${t.endDate}` : 'Dates TBD',
        memberCount: t.members?.length || 1,
        seatsLeft: Math.max(0, 8 - (t.members?.length || 1)),
        score: 0.7 + Math.random() * 0.25,
        matchedOn: { sharedInterests: [] }
      }));
    return sendJson(res, 200, { matches });
  }

  // ── 10. Photos & Face Groups (mock) ──────────────────────────────────────
  if (pathname.match(/^\/trips\/[^/]+\/face-consent$/) || pathname === '/photos/consent') {
    if (req.method === 'PUT' || req.method === 'POST') return sendJson(res, 200, { granted: !!body.granted });
    if (req.method === 'GET') return sendJson(res, 200, { granted: true });
  }

  if ((pathname.match(/^\/trips\/[^/]+\/photos\/presign$/) || pathname === '/photos/upload-urls') && req.method === 'POST') {
    const photoId = 'ph_' + crypto.randomUUID().slice(0, 8);
    return sendJson(res, 200, { photoId, uploadUrl: `https://${req.headers.host || 'wandermatch-app.vercel.app'}/api/mock-s3-upload/${photoId}` });
  }

  if (pathname.startsWith('/mock-s3-upload/')) return sendJson(res, 200, { uploaded: true });

  if ((pathname.match(/^\/trips\/[^/]+\/photos\/[^/]+\/complete$/) || pathname === '/photos/complete') && req.method === 'POST') {
    return sendJson(res, 200, { photoId: 'ph_demo', processed: true, facesDetected: 2 });
  }

  if ((pathname.match(/^\/trips\/[^/]+\/face-groups$/) || pathname === '/photos/face-groups') && req.method === 'GET') {
    return sendJson(res, 200, { groups: [] });
  }

  // ── 404 ──────────────────────────────────────────────────────────────────
  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No endpoint: ${req.method} ${pathname}` } });
};
