const crypto = require('crypto');

// ─── Universal Persistent Storage: Vercel KV / Upstash Redis ─────────────────
// Supports standard KV_REST_API_URL or any custom prefix configured in Vercel.
// Falls back gracefully to in-memory store so it never crashes.
// ─────────────────────────────────────────────────────────────────────────────

function getKvCredentials() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN };
  }
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
  }
  const envKeys = Object.keys(process.env);
  const urlKey = envKeys.find(k => k.endsWith('KV_REST_API_URL') || k.endsWith('REDIS_REST_URL') || k.endsWith('_REST_API_URL'));
  if (urlKey && process.env[urlKey]) {
    const tokenKey = urlKey.replace(/_URL$/, '_TOKEN');
    if (process.env[tokenKey]) {
      return { url: process.env[urlKey], token: process.env[tokenKey] };
    }
  }
  return { url: null, token: null };
}

const { url: KV_URL, token: KV_TOKEN } = getKvCredentials();
const USE_KV = !!(KV_URL && KV_TOKEN);

// Local in-memory cache and fallback
const mem = {
  users: {},
  sessions: {},
  trips: {},
  itineraries: {},
  proposals: {},
  globalProposals: []
};

// Low-level command execution against Upstash / Vercel KV REST API
async function redisCmd(cmdArray) {
  if (!USE_KV) return null;
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(cmdArray)
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.result;
  } catch (e) {
    return null;
  }
}

async function kvGet(key) {
  if (!USE_KV) return mem[key] || null;
  try {
    const res = await redisCmd(['GET', key]);
    if (res === null || res === undefined) return mem[key] || null;
    const parsed = typeof res === 'string' ? JSON.parse(res) : res;
    mem[key] = parsed; // sync local cache
    return parsed;
  } catch {
    return mem[key] || null;
  }
}

async function kvSet(key, value) {
  mem[key] = value;
  if (!USE_KV) return;
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    await redisCmd(['SET', key, str]);
  } catch {}
}

async function kvListGet(listKey) {
  const list = await kvGet(listKey);
  return Array.isArray(list) ? list : [];
}

async function kvListAdd(listKey, id) {
  const existing = await kvListGet(listKey);
  if (!existing.includes(id)) {
    existing.push(id);
    await kvSet(listKey, existing);
  }
}

// ─── Initial Demo Seed Data ──────────────────────────────────────────────────
const SEED_TRIPS = [
  {
    id: 'trip_manali_ridge',
    tripId: 'trip_manali_ridge',
    trip_id: 'trip_manali_ridge',
    title: 'Manali Ridge Crew',
    destination: 'Manali, Himachal Pradesh',
    startDate: '2027-03-10',
    endDate: '2027-03-15',
    ownerId: 'usr_alex',
    role: 'owner',
    isPublic: true,
    createdAt: '2026-03-01T10:00:00.000Z',
    memberCount: 4,
    seatsLeft: 4,
    interests: ['hiking', 'photography', 'food'],
    pace: 'packed',
    budgetBand: 'mid',
    members: [
      { userId: 'usr_alex', role: 'owner', name: 'Alex Rivera', shareWeight: 1 },
      { userId: 'usr_rae', role: 'editor', name: 'Rae Chen', shareWeight: 1 },
      { userId: 'usr_mo', role: 'viewer', name: 'Mo Patel', shareWeight: 1 }
    ]
  },
  {
    id: 'trip_gokarna_beach',
    tripId: 'trip_gokarna_beach',
    trip_id: 'trip_gokarna_beach',
    title: 'Gokarna Beach Bums',
    destination: 'Gokarna, Karnataka',
    startDate: '2027-01-05',
    endDate: '2027-01-10',
    ownerId: 'usr_sam',
    role: 'owner',
    isPublic: true,
    createdAt: '2026-03-01T10:00:00.000Z',
    memberCount: 3,
    seatsLeft: 5,
    interests: ['beaches', 'yoga', 'food'],
    pace: 'relaxed',
    budgetBand: 'budget',
    members: [
      { userId: 'usr_sam', role: 'owner', name: 'Samira Rao', shareWeight: 1 }
    ]
  },
  {
    id: 'trip_jaisalmer_desert',
    tripId: 'trip_jaisalmer_desert',
    trip_id: 'trip_jaisalmer_desert',
    title: 'Jaisalmer Desert Circuit',
    destination: 'Jaisalmer, Rajasthan',
    startDate: '2027-02-01',
    endDate: '2027-02-06',
    ownerId: 'usr_dev',
    role: 'owner',
    isPublic: true,
    createdAt: '2026-03-01T10:00:00.000Z',
    memberCount: 4,
    seatsLeft: 4,
    interests: ['history', 'photography', 'desert safari'],
    pace: 'moderate',
    budgetBand: 'mid',
    members: [
      { userId: 'usr_dev', role: 'owner', name: 'Dev Sharma', shareWeight: 1 }
    ]
  }
];

const SEED_ITINERARIES = {
  trip_manali_ridge: {
    tripId: 'trip_manali_ridge',
    version: 3,
    items: [
      { id: 'item_1', itemId: 'item_1', item_id: 'item_1', dayIndex: 0, time: '09:00', title: 'Old Manali Cafe Hop & Cedar Woods', cost: 650, notes: 'Great apple pie' },
      { id: 'item_2', itemId: 'item_2', item_id: 'item_2', dayIndex: 0, time: '14:30', title: 'Hadimba Devi Temple Pine Walk', cost: 100, notes: 'Historic pagoda wooden temple' },
      { id: 'item_3', itemId: 'item_3', item_id: 'item_3', dayIndex: 1, time: '08:00', title: 'Jogini Waterfall Sunrise Trek', cost: 400, notes: 'Bring hiking boots and camera' },
      { id: 'item_4', itemId: 'item_4', item_id: 'item_4', dayIndex: 2, time: '10:30', title: 'Solang Valley Paragliding & Cable Car', cost: 3200, notes: 'Panoramic snow peaks' }
    ]
  },
  trip_gokarna_beach: {
    tripId: 'trip_gokarna_beach',
    version: 1,
    items: [
      { id: 'item_g1', itemId: 'item_g1', item_id: 'item_g1', dayIndex: 0, time: '16:00', title: 'Kudle Beach Sunset & Drum Circle', cost: 250, notes: 'Beach shacks' },
      { id: 'item_g2', itemId: 'item_g2', item_id: 'item_g2', dayIndex: 1, time: '07:00', title: '5-Beach Cliffside Trek (Kudle to Paradise)', cost: 500, notes: 'Scenic trails' }
    ]
  },
  trip_jaisalmer_desert: {
    tripId: 'trip_jaisalmer_desert',
    version: 1,
    items: [
      { id: 'item_j1', itemId: 'item_j1', item_id: 'item_j1', dayIndex: 0, time: '15:00', title: 'Golden Fort & Havelis Guided Walk', cost: 400, notes: 'Living sandstone fort' },
      { id: 'item_j2', itemId: 'item_j2', item_id: 'item_j2', dayIndex: 1, time: '16:30', title: 'Sam Sand Dunes Camel Safari & Camp', cost: 2800, notes: 'Folk dance & stargazing' }
    ]
  }
};

const SEED_PROPOSALS = [
  {
    id: 'prop_gokarna',
    proposalId: 'prop_gokarna',
    proposal_id: 'prop_gokarna',
    name: 'Gokarna',
    title: 'Gokarna, Karnataka',
    destination: 'Gokarna',
    thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Om_beach_Gokarna.jpg/300px-Om_beach_Gokarna.jpg',
    proposedBy: 'Alex',
    rationale: 'Peaceful beaches, Om beach cafe sunset and coastal trek',
    votes: { alex: 'yes', rae: 'yes', mo: 'yes' },
    tally: { yes: 3, no: 0, abstain: 0 },
    reasons: {
      alex: 'The beach trek between Kudle and Om beach is unmatched',
      rae: 'Much quieter and more soulful than North Goa'
    },
    createdAt: '2026-03-01T10:00:00.000Z'
  },
  {
    id: 'prop_manali',
    proposalId: 'prop_manali',
    proposal_id: 'prop_manali',
    name: 'Manali',
    title: 'Manali, Himachal Pradesh',
    destination: 'Manali',
    thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/03/Manali_City.jpg/300px-Manali_City.jpg',
    proposedBy: 'Rae',
    rationale: 'Crisp mountain air, Jogini waterfall hike and old wooden cafes',
    votes: { rae: 'yes', you: 'yes' },
    tally: { yes: 2, no: 0, abstain: 0 },
    reasons: {
      rae: 'Perfect season for cool weather and pine forest trails'
    },
    createdAt: '2026-03-01T11:00:00.000Z'
  }
];

// Pre-populate in-memory cache
SEED_TRIPS.forEach(t => { mem.trips[t.id] = t; });
Object.entries(SEED_ITINERARIES).forEach(([id, it]) => { mem.itineraries[id] = it; });
mem.globalProposals = [...SEED_PROPOSALS];

// ─── Storage Helpers ─────────────────────────────────────────────────────────

async function getUser(email) {
  if (USE_KV) return await kvGet('user:' + email.toLowerCase());
  return mem.users[email.toLowerCase()] || null;
}

async function setUser(email, user) {
  if (USE_KV) await kvSet('user:' + email.toLowerCase(), user);
  mem.users[email.toLowerCase()] = user;
}

async function getSession(token) {
  if (USE_KV) return await kvGet('session:' + token);
  return mem.sessions[token] || null;
}

async function setSession(token, userId) {
  if (USE_KV) await kvSet('session:' + token, userId);
  mem.sessions[token] = userId;
}

async function getTrip(tripId) {
  if (USE_KV) {
    const trip = await kvGet('trip:' + tripId);
    if (trip) return trip;
  }
  return mem.trips[tripId] || null;
}

async function setTrip(tripId, trip) {
  if (USE_KV) await kvSet('trip:' + tripId, trip);
  mem.trips[tripId] = trip;
}

async function getAllPublicTrips() {
  let list = [];
  if (USE_KV) {
    const ids = await kvListGet('publictrips');
    if (ids.length) {
      const trips = await Promise.all(ids.map(id => kvGet('trip:' + id)));
      list = trips.filter(Boolean);
    }
  }
  if (!list.length) {
    list = Object.values(mem.trips).filter(t => t.isPublic !== false);
  }
  // Ensure seed trips are present if not already added
  const existingIds = new Set(list.map(t => t.id));
  for (const st of SEED_TRIPS) {
    if (!existingIds.has(st.id)) {
      list.push(st);
    }
  }
  return list;
}

async function addPublicTrip(tripId) {
  if (USE_KV) await kvListAdd('publictrips', tripId);
}

async function getUserTrips(userId) {
  if (USE_KV) {
    const ids = await kvListGet('usertrips:' + userId);
    if (ids.length) {
      const trips = await Promise.all(ids.map(id => kvGet('trip:' + id)));
      const filtered = trips.filter(Boolean);
      if (filtered.length) return filtered;
    }
  }
  return Object.values(mem.trips).filter(t =>
    t.ownerId === userId || (t.members || []).some(m => m.userId === userId)
  );
}

async function addTripToUser(userId, tripId) {
  if (USE_KV) await kvListAdd('usertrips:' + userId, tripId);
}

function buildStructuredDays(items, totalDays = 3) {
  const days = Array.from({ length: Math.max(1, totalDays) }, (_, i) => ({
    dayIndex: i,
    items: []
  }));
  (items || []).forEach(item => {
    const dIdx = Math.max(0, Math.min(days.length - 1, item.dayIndex ?? 0));
    days[dIdx].items.push(item);
  });
  return days;
}

async function getItinerary(tripId) {
  let itin = null;
  if (USE_KV) itin = await kvGet('itin:' + tripId);
  if (!itin) itin = mem.itineraries[tripId] || null;
  if (!itin) itin = { tripId, version: 1, items: [] };

  const days = buildStructuredDays(itin.items);
  return { ...itin, days };
}

async function setItinerary(tripId, itin) {
  const days = buildStructuredDays(itin.items);
  const clean = { ...itin, days };
  if (USE_KV) await kvSet('itin:' + tripId, clean);
  mem.itineraries[tripId] = clean;
  return clean;
}

async function getGlobalProposals() {
  if (USE_KV) {
    const props = await kvGet('global_proposals');
    if (Array.isArray(props) && props.length) return props;
  }
  return mem.globalProposals.length ? mem.globalProposals : SEED_PROPOSALS;
}

async function setGlobalProposals(list) {
  if (USE_KV) await kvSet('global_proposals', list);
  mem.globalProposals = list;
}

async function getTripProposals(tripId) {
  if (USE_KV) {
    const p = await kvGet('proposals:' + tripId);
    if (p) return p;
  }
  return mem.proposals[tripId] || [];
}

async function setTripProposals(tripId, list) {
  if (USE_KV) await kvSet('proposals:' + tripId, list);
  mem.proposals[tripId] = list;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getAuthUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const userId = await getSession(token);
  if (!userId) return null;
  return { id: userId, userId };
}

function sendJson(res, statusCode, data) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match, Accept');
  res.setHeader('Content-Type', 'application/json; charset=UTF-8');
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    res.status(statusCode).json(data);
  } else {
    res.statusCode = statusCode;
    res.end(JSON.stringify(data));
  }
}

// Worldwide destination search via Open-Meteo geocoding (free, reliable)
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
      state: c.admin1 || '',
      country_code: c.country_code || '',
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
    { id: 'city_manali', name: 'Manali', country: 'India', region: 'Himachal Pradesh', state: 'Himachal Pradesh', displayName: 'Manali, Himachal Pradesh, India', coordinates: [32.2396, 77.1887] },
    { id: 'city_gokarna', name: 'Gokarna', country: 'India', region: 'Karnataka', state: 'Karnataka', displayName: 'Gokarna, Karnataka, India', coordinates: [14.5479, 74.3188] },
    { id: 'city_jaisalmer', name: 'Jaisalmer', country: 'India', region: 'Rajasthan', state: 'Rajasthan', displayName: 'Jaisalmer, Rajasthan, India', coordinates: [26.9157, 70.9083] },
    { id: 'city_coorg', name: 'Coorg', country: 'India', region: 'Karnataka', state: 'Karnataka', displayName: 'Coorg, Karnataka, India', coordinates: [12.3375, 75.8069] },
    { id: 'city_leh', name: 'Leh', country: 'India', region: 'Ladakh', state: 'Ladakh', displayName: 'Leh, Ladakh, India', coordinates: [34.1526, 77.5771] },
    { id: 'city_munnar', name: 'Munnar', country: 'India', region: 'Kerala', state: 'Kerala', displayName: 'Munnar, Kerala, India', coordinates: [10.0889, 77.0595] },
    { id: 'city_rishikesh', name: 'Rishikesh', country: 'India', region: 'Uttarakhand', state: 'Uttarakhand', displayName: 'Rishikesh, Uttarakhand, India', coordinates: [30.0869, 78.2676] },
    { id: 'city_goa', name: 'Goa', country: 'India', region: 'Goa', state: 'Goa', displayName: 'Goa, India', coordinates: [15.2993, 74.1240] },
    { id: 'city_mumbai', name: 'Mumbai', country: 'India', region: 'Maharashtra', state: 'Maharashtra', displayName: 'Mumbai, Maharashtra, India', coordinates: [18.9220, 72.8347] },
    { id: 'city_kyoto', name: 'Kyoto', country: 'Japan', region: 'Kansai', state: '', displayName: 'Kyoto, Japan', coordinates: [35.0116, 135.7681] },
    { id: 'city_paris', name: 'Paris', country: 'France', region: 'Île-de-France', state: '', displayName: 'Paris, France', coordinates: [48.8566, 2.3522] },
    { id: 'city_bali', name: 'Bali', country: 'Indonesia', region: 'Bali', state: '', displayName: 'Bali, Indonesia', coordinates: [-8.3405, 115.0920] },
    { id: 'city_rome', name: 'Rome', country: 'Italy', region: 'Lazio', state: '', displayName: 'Rome, Italy', coordinates: [41.9028, 12.4964] },
    { id: 'city_tokyo', name: 'Tokyo', country: 'Japan', region: 'Kanto', state: '', displayName: 'Tokyo, Japan', coordinates: [35.6762, 139.6503] }
  ];
  const ql = (q || '').toLowerCase();
  return all.filter(c =>
    c.name.toLowerCase().includes(ql) ||
    c.country.toLowerCase().includes(ql) ||
    (c.region || '').toLowerCase().includes(ql)
  );
}

// ─── Main Request Handler ────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match, Accept');
    if (typeof res.status === 'function') {
      return res.status(204).end();
    } else {
      res.statusCode = 204;
      return res.end();
    }
  }

  let pathname = req.url.split('?')[0];
  if (pathname.startsWith('/api/v1/')) pathname = pathname.substring(7);
  else if (pathname.startsWith('/api/')) pathname = pathname.substring(4);

  // Parse body if not already parsed by serverless runtime
  let body = req.body;
  if (!body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
    try {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : {};
    } catch (_) {
      body = {};
    }
  }
  body = body || {};

  let query = req.query || {};
  if (req.url && req.url.includes('?')) {
    try {
      const sp = new URLSearchParams(req.url.split('?')[1]);
      query = { ...Object.fromEntries(sp.entries()), ...query };
    } catch (_) {}
  }

  // ── 1. Health ──────────────────────────────────────────────────────────────
  if (pathname === '/health' || pathname === '/handler') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'wandermatch-api',
      storage: USE_KV ? 'vercel-kv' : 'in-memory',
      version: '2.1.0',
      timestamp: new Date().toISOString()
    });
  }

  // ── 2. Reference & Destination Search ──────────────────────────────────────
  if ((pathname === '/destinations/search' || pathname === '/reference/cities') && req.method === 'GET') {
    const q = query.q || query.query || '';
    const results = await searchDestinations(q);
    return sendJson(res, 200, { cities: results, results });
  }

  // ── 3. Authentication ──────────────────────────────────────────────────────
  if (pathname === '/auth/signup' && req.method === 'POST') {
    if (!body.email || !body.password) {
      return sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Email and password required' } });
    }
    if (body.password.length < 6) {
      return sendJson(res, 422, { error: { code: 'VALIDATION_FAILED', message: 'Password must be at least 6 characters' } });
    }

    const existing = await getUser(body.email);
    if (existing && existing.passwordHash) {
      return sendJson(res, 409, { error: { code: 'EMAIL_TAKEN', message: 'An account with this email already exists. Please log in.' } });
    }

    const userId = 'usr_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const displayName = body.displayName || body.name || body.email.split('@')[0];
    const user = {
      id: userId,
      userId,
      user_id: userId,
      email: body.email.toLowerCase(),
      name: displayName,
      displayName,
      display_name: displayName,
      locale: body.locale || 'en',
      createdAt: new Date().toISOString(),
      passwordHash: crypto.createHash('sha256').update(body.password + userId).digest('hex')
    };
    await setUser(body.email, user);
    const token = 'wmt_' + crypto.randomBytes(32).toString('hex');
    await setSession(token, userId);
    const { passwordHash, ...safeUser } = user;
    return sendJson(res, 201, { token, user: safeUser });
  }

  if (pathname === '/auth/login' && req.method === 'POST') {
    if (!body.email) {
      return sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Email required' } });
    }

    let user = await getUser(body.email);
    if (!user) {
      // Auto-create on first login for smooth demo / hackathon experience
      const userId = 'usr_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      const displayName = body.displayName || body.name || body.email.split('@')[0];
      user = {
        id: userId,
        userId,
        user_id: userId,
        email: body.email.toLowerCase(),
        name: displayName,
        displayName,
        display_name: displayName,
        locale: 'en',
        createdAt: new Date().toISOString(),
        passwordHash: body.password ? crypto.createHash('sha256').update(body.password + userId).digest('hex') : null
      };
      await setUser(body.email, user);
    } else if (user.passwordHash && body.password) {
      const hash = crypto.createHash('sha256').update(body.password + user.id).digest('hex');
      if (hash !== user.passwordHash) {
        return sendJson(res, 401, { error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect password' } });
      }
    }
    const token = 'wmt_' + crypto.randomBytes(32).toString('hex');
    await setSession(token, user.id);
    const { passwordHash, ...safeUser } = user;
    return sendJson(res, 200, { token, user: safeUser });
  }

  if (pathname === '/auth/me' && req.method === 'GET') {
    const auth = await getAuthUser(req);
    if (!auth) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Not logged in' } });
    return sendJson(res, 200, { user: auth });
  }

  // ── 4. Proposals & Community Voting ─────────────────────────────────────────

  // Global proposals (powers the main "Where are we going?" voting board)
  if (pathname === '/proposals' && req.method === 'GET') {
    const proposals = await getGlobalProposals();
    return sendJson(res, 200, { proposals });
  }

  if (pathname === '/proposals' && req.method === 'POST') {
    const auth = await getAuthUser(req);
    const propId = 'prop_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const creatorName = body.proposedBy || auth?.displayName || 'Traveler';
    const newProp = {
      id: propId,
      proposalId: propId,
      proposal_id: propId,
      name: body.name || body.title || 'New Destination',
      title: body.title || body.name || 'New Destination',
      destination: body.destination || body.name || body.title || '',
      thumbnail: body.thumbnail || null,
      creditHtml: body.creditHtml || '',
      proposedBy: creatorName,
      rationale: body.rationale || `Proposed by ${creatorName}`,
      votes: { [creatorName.toLowerCase()]: 'yes' },
      tally: { yes: 1, no: 0, abstain: 0 },
      reasons: body.reasons || {},
      status: 'open',
      createdAt: new Date().toISOString()
    };
    const list = await getGlobalProposals();
    list.unshift(newProp);
    await setGlobalProposals(list);
    return sendJson(res, 201, { proposal: newProp });
  }

  const globalVoteMatch = pathname.match(/^\/proposals\/([^/]+)\/votes?$/);
  if (globalVoteMatch && req.method === 'POST') {
    const propId = globalVoteMatch[1];
    const auth = await getAuthUser(req);
    const voterId = (body.voter || body.voterName || auth?.id || 'you').toLowerCase();
    const list = await getGlobalProposals();
    const prop = list.find(p => p.id === propId || p.proposal_id === propId);
    if (!prop) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Proposal not found' } });

    if (typeof prop.votes !== 'object' || prop.votes === null || Array.isArray(prop.votes)) {
      const existingVoters = Array.isArray(prop.voters) ? prop.voters : [];
      prop.userVotes = {};
      existingVoters.forEach(v => { prop.userVotes[v] = 'yes'; });
    } else {
      prop.userVotes = prop.votes;
    }
    if (!prop.tally) prop.tally = { yes: Object.keys(prop.userVotes || {}).length, no: 0, abstain: 0 };
    if (!prop.reasons) prop.reasons = {};

    const voteVal = body.value || body.vote || 'yes';
    const oldVote = prop.userVotes[voterId];

    if (oldVote && prop.tally[oldVote] > 0) prop.tally[oldVote]--;

    if (body.remove) {
      delete prop.userVotes[voterId];
    } else {
      prop.userVotes[voterId] = voteVal;
      prop.tally[voteVal] = (prop.tally[voteVal] || 0) + 1;
      if (body.comment || body.reason) {
        prop.reasons[voterId] = body.comment || body.reason;
      }
    }

    prop.voters = Object.keys(prop.userVotes).filter(k => prop.userVotes[k] === 'yes');
    prop.votes = prop.voters.length;

    await setGlobalProposals(list);
    const outcome = prop.tally.yes > prop.tally.no ? 'accepted' : prop.tally.no > prop.tally.yes ? 'rejected' : 'tied';
    return sendJson(res, 200, { outcome, tally: prop.tally, proposal: prop });
  }

  if (pathname === '/proposals/consensus' && req.method === 'GET') {
    const list = await getGlobalProposals();
    const ranked = [...list].sort((a, b) => (b.tally?.yes || 0) - (a.tally?.yes || 0));
    const winner = ranked[0];
    return sendJson(res, 200, {
      outcome: winner && (winner.tally?.yes || 0) > 0 ? 'accepted' : 'tied',
      consensus: {
        strategy: 'majority',
        recommendation: winner ? winner.name : 'Munnar',
        rationale: winner ? `${winner.tally?.yes || 1} votes favor ${winner.name}` : 'Voting in progress',
        groundingPassed: true
      }
    });
  }

  // ── 5. Trips ────────────────────────────────────────────────────────────────

  // Create a trip
  if (pathname === '/trips' && req.method === 'POST') {
    const auth = await getAuthUser(req);
    const userId = auth?.id || body.ownerId || 'usr_creator';
    const tripId = 'trip_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    const creatorName = body.creatorName || auth?.displayName || 'You';
    const dest = body.destination || body.title || 'Adventure';

    const newTrip = {
      id: tripId,
      tripId,
      trip_id: tripId,
      title: body.title || body.name || `Trip to ${dest}`,
      name: body.title || body.name || `Trip to ${dest}`,
      destination: dest,
      startDate: body.startDate || '2027-03-10',
      endDate: body.endDate || '2027-03-15',
      ownerId: userId,
      role: 'owner',
      isPublic: body.isPublic !== false,
      interests: body.interests || ['hiking', 'photography', 'food'],
      pace: body.pace || 'moderate',
      budgetBand: body.budgetBand || 'mid',
      memberCount: 1,
      seatsLeft: 7,
      createdAt: new Date().toISOString(),
      members: [
        { userId, role: 'owner', name: creatorName, shareWeight: 1 }
      ]
    };

    await setTrip(tripId, newTrip);
    await addTripToUser(userId, tripId);
    await addPublicTrip(tripId);
    await setItinerary(tripId, { tripId, version: 1, items: [] });
    await setTripProposals(tripId, []);

    return sendJson(res, 201, { trip: newTrip });
  }

  // List all public trips (for browsing and matching)
  if (pathname === '/trips' && req.method === 'GET') {
    const q = (query.destination || query.q || '').toLowerCase();
    let trips = await getAllPublicTrips();
    if (q) {
      trips = trips.filter(t =>
        (t.destination || '').toLowerCase().includes(q) ||
        (t.title || '').toLowerCase().includes(q)
      );
    }
    return sendJson(res, 200, { trips });
  }

  // List my trips
  if (pathname === '/trips/mine' && req.method === 'GET') {
    const auth = await getAuthUser(req);
    const userId = auth?.id || 'usr_creator';
    const trips = await getUserTrips(userId);
    return sendJson(res, 200, { trips });
  }

  // Search trips
  if (pathname === '/trips/search' && req.method === 'GET') {
    const q = (query.q || query.destination || '').toLowerCase();
    const trips = await getAllPublicTrips();
    const results = q
      ? trips.filter(t =>
          (t.destination || '').toLowerCase().includes(q) ||
          (t.title || '').toLowerCase().includes(q)
        )
      : trips;
    return sendJson(res, 200, { trips: results });
  }

  // Single trip details
  const tripSingleMatch = pathname.match(/^\/trips\/([^/]+)$/);
  if (tripSingleMatch && req.method === 'GET') {
    const tripId = tripSingleMatch[1];
    const trip = await getTrip(tripId);
    if (!trip) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Trip not found' } });
    return sendJson(res, 200, { trip });
  }

  // Join a trip
  const joinMatch = pathname.match(/^\/trips\/([^/]+)\/join-requests$/);
  if (joinMatch && req.method === 'POST') {
    const tripId = joinMatch[1];
    const auth = await getAuthUser(req);
    const userId = auth?.id || 'usr_guest_' + crypto.randomUUID().slice(0, 6);
    const userName = body.name || body.userName || 'New Member';
    const trip = await getTrip(tripId);
    if (!trip) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Trip not found' } });

    if (!trip.members.some(m => m.userId === userId)) {
      trip.members.push({
        userId,
        role: 'editor',
        name: userName,
        shareWeight: 1,
        joinedAt: new Date().toISOString()
      });
      trip.memberCount = trip.members.length;
      trip.seatsLeft = Math.max(0, 8 - trip.members.length);
      await setTrip(tripId, trip);
      await addTripToUser(userId, tripId);
    }
    const requestId = 'req_' + crypto.randomUUID().slice(0, 8);
    return sendJson(res, 201, { requestId, status: 'approved', trip });
  }

  // ── 6. Itinerary Day-by-Day ────────────────────────────────────────────────
  const tripItinMatch = pathname.match(/^\/trips\/([^/]+)\/itinerary$/);
  if (tripItinMatch && req.method === 'GET') {
    const tripId = tripItinMatch[1];
    const itin = await getItinerary(tripId);
    return sendJson(res, 200, itin);
  }

  const tripItemsMatch = pathname.match(/^\/trips\/([^/]+)\/itinerary\/items$/);
  if (tripItemsMatch && req.method === 'POST') {
    const tripId = tripItemsMatch[1];
    const itin = await getItinerary(tripId);
    const itemId = 'item_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const newItem = {
      id: itemId,
      itemId,
      item_id: itemId,
      dayIndex: body.dayIndex ?? 0,
      time: body.time || '10:00',
      title: body.title || 'New Activity',
      cost: Number(body.cost) || 0,
      category: body.category || 'activity',
      notes: body.notes || ''
    };
    itin.items.push(newItem);
    itin.version = (itin.version || 1) + 1;
    const updated = await setItinerary(tripId, itin);
    return sendJson(res, 201, { item: newItem, version: updated.version, days: updated.days });
  }

  const tripItemMatch = pathname.match(/^\/trips\/([^/]+)\/itinerary\/items\/([^/]+)$/);
  if (tripItemMatch) {
    const [, tripId, itemId] = tripItemMatch;
    const itin = await getItinerary(tripId);

    if (req.method === 'PUT' || req.method === 'PATCH') {
      const ifMatch = req.headers['if-match'];
      if (ifMatch && parseInt(ifMatch, 10) !== itin.version) {
        return sendJson(res, 409, {
          error: {
            code: 'VERSION_CONFLICT',
            message: 'Concurrent edit detected. Please reload latest plan.',
            currentVersion: itin.version
          }
        });
      }
      const idx = itin.items.findIndex(i => i.id === itemId || i.item_id === itemId);
      if (idx >= 0) {
        itin.items[idx] = {
          ...itin.items[idx],
          ...body,
          id: itemId,
          item_id: itemId
        };
      } else {
        itin.items.push({ id: itemId, item_id: itemId, ...body });
      }
      itin.version = (itin.version || 1) + 1;
      const updated = await setItinerary(tripId, itin);
      return sendJson(res, 200, {
        item: itin.items[idx >= 0 ? idx : itin.items.length - 1],
        version: updated.version,
        days: updated.days
      });
    }

    if (req.method === 'DELETE') {
      itin.items = itin.items.filter(i => i.id !== itemId && i.item_id !== itemId);
      itin.version = (itin.version || 1) + 1;
      const updated = await setItinerary(tripId, itin);
      return sendJson(res, 200, { success: true, version: updated.version, days: updated.days });
    }
  }

  // ── 7. Trip Scoped Proposals ───────────────────────────────────────────────
  const propMatch = pathname.match(/^\/trips\/([^/]+)\/proposals$/);
  if (propMatch) {
    const tripId = propMatch[1];
    if (req.method === 'GET') {
      return sendJson(res, 200, { proposals: await getTripProposals(tripId) });
    }
    if (req.method === 'POST') {
      const auth = await getAuthUser(req);
      const propId = 'prop_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
      const newProp = {
        id: propId,
        proposalId: propId,
        proposal_id: propId,
        tripId,
        title: body.title || body.name || 'New Proposal',
        name: body.title || body.name || 'New Proposal',
        destination: body.destination || body.title || '',
        rationale: body.rationale || '',
        proposedBy: auth?.displayName || body.proposedBy || 'Guest',
        votes: {},
        tally: { yes: 0, no: 0, abstain: 0 },
        status: 'open',
        createdAt: new Date().toISOString()
      };
      const list = await getTripProposals(tripId);
      list.push(newProp);
      await setTripProposals(tripId, list);
      return sendJson(res, 201, { proposal: newProp });
    }
  }

  // ── 8. Solo-to-Group Matching ──────────────────────────────────────────────
  if ((pathname === '/matching/search' || pathname === '/matching') && req.method === 'POST') {
    const dest = (body.destination || body.destinationCityId || '').toLowerCase().replace(/^city_/, '');
    const soloInterests = new Set((body.interests || []).map(i => i.toLowerCase()));
    const trips = await getAllPublicTrips();

    const matches = trips
      .filter(t => !dest || (t.destination || '').toLowerCase().includes(dest) || (t.title || '').toLowerCase().includes(dest))
      .map(t => {
        const tripInterests = new Set((t.interests || ['hiking', 'food']).map(i => i.toLowerCase()));
        let sharedCount = 0;
        soloInterests.forEach(i => { if (tripInterests.has(i)) sharedCount++; });
        const unionCount = Math.max(1, new Set([...soloInterests, ...tripInterests]).size);
        const interestScore = sharedCount / unionCount;

        const dateScore = 0.85; // healthy overlap default
        const paceScore = (body.pace && t.pace && body.pace === t.pace) ? 1.0 : 0.75;
        const budgetScore = (body.budgetBand && t.budgetBand && body.budgetBand === t.budgetBand) ? 1.0 : 0.8;

        const total = Math.min(0.98, Math.max(0.65,
          (0.40 * interestScore) + (0.25 * dateScore) + (0.20 * paceScore) + (0.15 * budgetScore)
        ));

        return {
          tripId: t.id,
          id: t.id,
          name: t.title || t.name,
          title: t.title || t.name,
          destination: t.destination,
          destinationCityId: 'city_' + (t.destination || '').toLowerCase().replace(/[^a-z]/g, ''),
          startDate: t.startDate || '2027-03-10',
          endDate: t.endDate || '2027-03-15',
          dates: t.startDate && t.endDate ? `${t.startDate} → ${t.endDate}` : 'Dates TBD',
          memberCount: t.members?.length || t.memberCount || 1,
          seatsLeft: t.seatsLeft ?? Math.max(0, 8 - (t.members?.length || 1)),
          score: Number(total.toFixed(2)),
          components: {
            interestScore: Number(interestScore.toFixed(2)),
            dateScore,
            paceScore,
            budgetScore
          },
          matchedOn: { sharedInterests: Array.from(tripInterests).slice(0, 3) }
        };
      })
      .sort((a, b) => b.score - a.score);

    return sendJson(res, 200, { matches });
  }

  // ── 9. Photos & Face Recognition Pipeline ─────────────────────────────────
  if (pathname.match(/^\/trips\/[^/]+\/face-consent$/) || pathname === '/photos/consent') {
    if (req.method === 'PUT' || req.method === 'POST') return sendJson(res, 200, { granted: !!body.granted });
    if (req.method === 'GET') return sendJson(res, 200, { granted: true });
  }

  if (pathname.match(/^\/trips\/[^/]+\/photos\/presign$/) || pathname === '/photos/upload-urls') {
    const photoId = 'ph_' + crypto.randomUUID().slice(0, 8);
    const host = req.headers.host || 'wandermatch-app.vercel.app';
    return sendJson(res, 200, {
      photoId,
      uploadUrl: `https://${host}/api/mock-s3-upload/${photoId}`
    });
  }

  if (pathname.startsWith('/mock-s3-upload/')) {
    return sendJson(res, 200, { uploaded: true });
  }

  if (pathname.match(/^\/trips\/[^/]+\/photos\/[^/]+\/complete$/) || pathname === '/photos/complete') {
    return sendJson(res, 200, { photoId: 'ph_demo', processed: true, facesDetected: 2 });
  }

  if (pathname.match(/^\/trips\/[^/]+\/face-groups$/) || pathname === '/photos/face-groups') {
    return sendJson(res, 200, { faceGroups: [] });
  }

  // ── 404 ────────────────────────────────────────────────────────────────────
  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No endpoint: ${req.method} ${pathname}` } });
};
