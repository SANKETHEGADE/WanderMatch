# WanderMatch — local server

A real Node/Express backend backing the WanderMatch prototype: accounts,
shared trips with roles, group voting with an AI tie-breaker, a day-by-day
itinerary board with real optimistic-concurrency conflict handling,
solo-to-group matching, and face-cluster storage. Data lives in a JSON
file on disk (`db.json`) rather than a real database engine — a real,
working store, just not one built for concurrent-writer load.

## File structure

```
wandermatch-server/
├── server.js         # Express app: every /api/* route
├── db.js             # JSON-file "database" + seed open trips
├── db.json           # created automatically on first run — your data
├── package.json
├── public/
│   └── index.html    # the frontend (served as a static file)
└── README.md
```

## Running it

```bash
cd wandermatch-server
npm install
node server.js
```

Then open **http://localhost:3000** in your browser — not as a `file://`
path. The frontend's API calls are relative (`/api/...`), so they only
resolve when the page is actually served by this server.

## Enabling the AI tie-breaker (optional)

Without a key, ties fall back to a plainly-labeled non-AI default. To turn
on the real consensus planner:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node server.js
```

The key stays server-side — it's never sent to or visible from the
browser, unlike the earlier version of this prototype where each visitor
pasted in their own key.

## Demoing multi-account collaboration

Since accounts are now real, "the group" is real people logging in from
different browser sessions, not a seat-switcher in one tab:

1. Sign up as yourself, create a trip, and invite a crewmate by email
   (they need an existing account — invite emails that don't match one
   yet are just reported back, not silently dropped).
2. Open a second browser (or an incognito window), sign up as that
   crewmate, and log in. Their invited trip appears under "My trips."
3. Propose, vote, and edit the itinerary from both sessions — you're
   looking at the same server-side trip.
4. To see the optimistic-concurrency conflict for real: open an item to
   edit in one session, then edit or delete something in the *other*
   session, then try to save the stale edit. It's rejected, not silently
   overwritten. There's also a "simulate" button in the itinerary board
   for demoing this solo, without a second session.

## What's still simplified versus a production build

- **Sessions** are an in-memory token map — restarting the server logs
  everyone out. Fine for a demo; a real deployment would want persistent
  sessions or JWTs.
- **Google/Apple sign-in** decodes the identity token client-side and
  trusts it as-is; a production build would verify the signature
  server-side before creating an account.
- **`db.json`** reads and rewrites the whole file per request. That's
  correct at this scale and wrong at real concurrent-writer scale — the
  point where you'd want Postgres, matching the original design doc.
- **Face detection** still runs entirely in the browser (TensorFlow.js);
  only the resulting cropped thumbnails and any name you add are sent to
  the server, tied to the trip — original uploaded photos never leave
  the device.