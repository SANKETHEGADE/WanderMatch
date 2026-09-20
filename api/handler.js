const crypto = require('crypto');

// ─── In-Memory DB (resets per cold start — fine for demo) ───
const db = {
  users: new Map(),
  sessions: new Map(),
  trips: new Map(),
  itineraries: new Map(),
  proposals: new Map()
};

// Seed demo data
const demoUserId = 'usr_demo_123';
db.users.set('wanderer@example.com', {
  id: demoUserId, email: 'wanderer@example.com',
  name: 'Alex Rivera', displayName: 'Alex Rivera',
  locale: 'en-US', createdAt: new Date().toISOString()
});
const demoToken = 'jwt_demo_fixed_token';
db.sessions.set(demoToken, demoUserId);

const demoTripId = 'trip_demo_himalayas';
db.trips.set(demoTripId, {
  id: demoTripId, title: 'Himalayan Foothills Explorer',
  destination: 'Manali, Himachal Pradesh',
  startDate: '2027-03-10', endDate: '2027-03-16',
  ownerId: demoUserId,
  members: [{ userId: demoUserId, role: 'owner', shareWeight: 1 }]
});

db.itineraries.set(demoTripId, {
  tripId: demoTripId, version: 1,
  items: [
    { id: 'item_1', dayIndex: 0, time: '09:00', title: 'Old Manali Cafe Hop & Cedar Woods', category: 'activity', notes: 'Great apple pie' },
    { id: 'item_2', dayIndex: 1, time: '07:30', title: 'Jogini Waterfall Sunrise Trek', category: 'activity', notes: 'Bring hiking boots' }
  ]
});

db.proposals.set(demoTripId, [
  { id: 'prop_1', proposal_id: 'prop_1', tripId: demoTripId, title: 'Solang Valley Paragliding', rationale: 'Thrilling aerial view of snow peaks', votes: {} },
  { id: 'prop_2', proposal_id: 'prop_2', tripId: demoTripId, title: 'Naggar Castle & Heritage Walk', rationale: 'Rich culture and peaceful Himalayan architecture', votes: {} }
]);

// ─── Helpers ───
function getAuthUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const userId = db.sessions.get(token);
  if (!userId) return null;
  for (const u of db.users.values()) {
    if (u.id === userId) return u;
  }
  return { id: userId, email: 'user@example.com', name: 'Traveller' };
}

function sendJson(res, statusCode, data) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match, Accept');
  res.setHeader('Content-Type', 'application/json; charset=UTF-8');
  res.status(statusCode).json(data);
}

// ─── Vercel Serverless Handler ───
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

  // 1. Health
  if (pathname === '/health' || pathname === '/handler') {
    return sendJson(res, 200, {
      status: 'ok', service: 'wandermatch-api-vercel',
      version: '1.0.0', timestamp: new Date().toISOString()
    });
  }

  // 2. Auth
  if (pathname === '/auth/signup' && req.method === 'POST') {
    if (!body.email || !body.password) return sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Email and password required' } });
    if (body.password.length < 10) return sendJson(res, 422, { error: { code: 'VALIDATION_FAILED', message: 'Password must be at least 10 characters' } });
    const userId = 'usr_' + crypto.randomUUID().slice(0, 8);
    const user = { id: userId, userId, email: body.email, name: body.displayName || body.email.split('@')[0], displayName: body.displayName || body.email.split('@')[0], locale: body.locale || 'en-US' };
    db.users.set(body.email, user);
    const token = 'jwt_' + crypto.randomBytes(24).toString('hex');
    db.sessions.set(token, userId);
    return sendJson(res, 201, { token, user });
  }

  if (pathname === '/auth/login' && req.method === 'POST') {
    let user = db.users.get(body.email);
    if (!user) {
      const userId = 'usr_' + crypto.randomUUID().slice(0, 8);
      user = { id: userId, userId, email: body.email, name: body.email.split('@')[0], displayName: body.email.split('@')[0] };
      db.users.set(body.email, user);
    }
    const token = 'jwt_' + crypto.randomBytes(24).toString('hex');
    db.sessions.set(token, user.id);
    return sendJson(res, 200, { token, user });
  }

  if (pathname === '/auth/me' && req.method === 'GET') {
    const user = getAuthUser(req) || { id: demoUserId, email: 'wanderer@example.com', name: 'Alex Rivera' };
    return sendJson(res, 200, { user });
  }

  // 3. Trips
  if (pathname === '/trips' && req.method === 'POST') {
    const user = getAuthUser(req) || { id: demoUserId };
    const tripId = 'trip_' + crypto.randomUUID().slice(0, 8);
    const newTrip = { id: tripId, trip_id: tripId, title: body.title || 'Untitled Adventure', destination: body.destination || '', startDate: body.startDate || '', endDate: body.endDate || '', ownerId: user.id, role: 'owner', members: [{ userId: user.id, role: 'owner', shareWeight: 1 }] };
    db.trips.set(tripId, newTrip);
    db.itineraries.set(tripId, { tripId, version: 1, items: [] });
    return sendJson(res, 201, { trip: newTrip });
  }

  if (pathname === '/trips' && req.method === 'GET') {
    return sendJson(res, 200, { trips: Array.from(db.trips.values()) });
  }

  // Itinerary Items CRUD
  const tripItemMatch = pathname.match(/^\/trips\/([^/]+)\/itinerary\/items\/([^/]+)$/);
  if (tripItemMatch) {
    const [, tripId, itemId] = tripItemMatch;
    let itin = db.itineraries.get(tripId) || { tripId, version: 1, items: [] };
    db.itineraries.set(tripId, itin);

    if (req.method === 'PUT' || req.method === 'PATCH') {
      const ifMatch = req.headers['if-match'];
      if (ifMatch && parseInt(ifMatch, 10) !== itin.version) {
        return sendJson(res, 409, { error: { code: 'VERSION_CONFLICT', message: 'Concurrent edit detected. Please reload.', expectedVersion: itin.version, currentVersion: itin.version } });
      }
      const idx = itin.items.findIndex(i => i.id === itemId);
      if (idx >= 0) itin.items[idx] = { ...itin.items[idx], ...body };
      else itin.items.push({ id: itemId, ...body });
      itin.version += 1;
      return sendJson(res, 200, { item: itin.items[idx >= 0 ? idx : itin.items.length - 1], version: itin.version });
    }

    if (req.method === 'DELETE') {
      itin.items = itin.items.filter(i => i.id !== itemId);
      itin.version += 1;
      return sendJson(res, 200, { success: true, version: itin.version });
    }
  }

  const tripItemsMatch = pathname.match(/^\/trips\/([^/]+)\/itinerary\/items$/);
  if (tripItemsMatch && req.method === 'POST') {
    const tripId = tripItemsMatch[1];
    let itin = db.itineraries.get(tripId) || { tripId, version: 1, items: [] };
    db.itineraries.set(tripId, itin);
    const newItem = { id: 'item_' + crypto.randomUUID().slice(0, 8), dayIndex: body.dayIndex ?? 0, time: body.time || '10:00', title: body.title || 'New Activity', category: body.category || 'activity', notes: body.notes || '' };
    itin.items.push(newItem);
    itin.version += 1;
    return sendJson(res, 201, { item: newItem, version: itin.version });
  }

  const tripItinMatch = pathname.match(/^\/trips\/([^/]+)\/itinerary$/);
  if (tripItinMatch && req.method === 'GET') {
    const tripId = tripItinMatch[1];
    const itin = db.itineraries.get(tripId) || { tripId, version: 1, items: [] };
    return sendJson(res, 200, itin);
  }

  const tripSingleMatch = pathname.match(/^\/trips\/([^/]+)$/);
  if (tripSingleMatch && req.method === 'GET') {
    const tripId = tripSingleMatch[1];
    const trip = db.trips.get(tripId) || { id: tripId, title: 'Trip #' + tripId, yourRole: 'owner' };
    return sendJson(res, 200, { trip });
  }

  // 4. Proposals & Consensus
  const voteMatch = pathname.match(/^\/trips\/([^/]+)\/proposals\/([^/]+)\/vote(s)?$/);
  if (voteMatch && req.method === 'POST') {
    const user = getAuthUser(req) || { id: demoUserId };
    return sendJson(res, 200, { outcome: 'accepted', vote: { proposalId: voteMatch[2], userId: user.id, weight: body.weight || 1, value: body.value || 'yes' }, tally: { yes: 3, no: 0, abstain: 0 } });
  }

  const consensusMatch = pathname.match(/^\/trips\/([^/]+)\/proposals\/(consensus|[^/]+\/consensus)$/);
  if (consensusMatch && req.method === 'GET') {
    return sendJson(res, 200, { outcome: 'tied', consensus: { strategy: 'synthesise', recommendation: 'Combine Solang Valley morning activities with Naggar Castle afternoon walk.', rationale: 'Balanced itinerary accommodating scenic adventure and heritage walking preferences.', cites: [{ user_id: demoUserId, reason: 'prefers scenic sights with moderate pace' }], groundingPassed: true, isFallback: false } });
  }

  const propMatch = pathname.match(/^\/trips\/([^/]+)\/proposals$/);
  if (propMatch) {
    const tripId = propMatch[1];
    if (req.method === 'POST') {
      const newProp = { id: 'prop_' + crypto.randomUUID().slice(0, 8), proposal_id: 'prop_' + crypto.randomUUID().slice(0, 8), tripId, title: body.title || 'Proposed Stop', rationale: body.rationale || '', createdAt: new Date().toISOString() };
      let list = db.proposals.get(tripId) || [];
      list.push(newProp);
      db.proposals.set(tripId, list);
      return sendJson(res, 201, { proposal: newProp });
    }
    if (req.method === 'GET') return sendJson(res, 200, { proposals: db.proposals.get(tripId) || [] });
  }

  // 5. Matching
  if ((pathname === '/matching/search' || pathname === '/matching') && req.method === 'POST') {
    return sendJson(res, 200, {
      weights: { interests: 0.4, dates: 0.25, pace: 0.2, budget: 0.15 },
      matches: [
        { tripId: 'trip_match_1', title: 'Kyoto Autumn Temple & Garden Tour', destination: 'Kyoto, Japan', dates: '2027-10-14 - 2027-10-22', score: 0.88, components: { interestScore: 0.95, dateScore: 0.90, paceScore: 0.85, budgetScore: 0.80 }, matchedOn: { sharedInterests: ['culture', 'gardens', 'photography'] }, seatsLeft: 3 },
        { tripId: 'trip_match_2', title: 'Dolomites Alpine Hiking & Via Ferrata', destination: "Cortina d'Ampezzo, Italy", dates: '2027-07-02 - 2027-07-10', score: 0.82, components: { interestScore: 0.90, dateScore: 0.80, paceScore: 0.75, budgetScore: 0.85 }, matchedOn: { sharedInterests: ['hiking', 'mountains'] }, seatsLeft: 2 }
      ]
    });
  }

  // 6. Join Requests
  if (pathname.match(/^\/trips\/[^/]+\/join-requests$/) && req.method === 'POST') {
    return sendJson(res, 201, { requestId: 'req_' + crypto.randomUUID().slice(0, 8), status: 'pending' });
  }

  // 7. Photos & Face Grouping
  if (pathname.match(/^\/trips\/[^/]+\/face-consent$/) || pathname === '/photos/consent') {
    if (req.method === 'PUT' || req.method === 'POST') return sendJson(res, 200, { granted: !!body.granted || !!body.consent });
    if (req.method === 'GET') return sendJson(res, 200, { granted: true });
  }

  if ((pathname.match(/^\/trips\/[^/]+\/photos\/presign$/) || pathname === '/photos/upload-urls') && req.method === 'POST') {
    const photoId = 'ph_' + crypto.randomUUID().slice(0, 8);
    return sendJson(res, 200, { photoId, uploadUrl: `https://${req.headers.host || 'wandermatch.vercel.app'}/api/mock-s3-upload/${photoId}` });
  }

  if (pathname.startsWith('/mock-s3-upload/')) return sendJson(res, 200, { uploaded: true });

  if ((pathname.match(/^\/trips\/[^/]+\/photos\/[^/]+\/complete$/) || pathname === '/photos/complete') && req.method === 'POST') {
    return sendJson(res, 200, { photoId: 'ph_demo', processed: true, facesDetected: 3 });
  }

  if ((pathname.match(/^\/trips\/[^/]+\/face-groups$/) || pathname === '/photos/face-groups') && req.method === 'GET') {
    return sendJson(res, 200, { groups: [
      { id: 'grp_1', label: 'Alex (You)', photoCount: 14, avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150' },
      { id: 'grp_2', label: 'Elena R.', photoCount: 9, avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150' }
    ] });
  }

  // 8. Reference
  if (pathname === '/reference/cities' && req.method === 'GET') {
    const q = (query.q || '').toLowerCase();
    const cities = [
      { id: 'city_manali', name: 'Manali', country: 'India', coordinates: [32.2396, 77.1887] },
      { id: 'city_kyoto', name: 'Kyoto', country: 'Japan', coordinates: [35.0116, 135.7681] },
      { id: 'city_paris', name: 'Paris', country: 'France', coordinates: [48.8566, 2.3522] },
      { id: 'city_rome', name: 'Rome', country: 'Italy', coordinates: [41.9028, 12.4964] },
      { id: 'city_reykjavik', name: 'Reykjavik', country: 'Iceland', coordinates: [64.1466, -21.9426] }
    ].filter(c => !q || c.name.toLowerCase().includes(q) || c.country.toLowerCase().includes(q));
    return sendJson(res, 200, { cities });
  }

  // 404
  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Endpoint ${req.method} ${pathname} not found` } });
};
