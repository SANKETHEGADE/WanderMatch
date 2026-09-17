-- Demo seed: one trip whose vote is deliberately tied, so the consensus
-- planner can be demonstrated on cue rather than hoped for.
--
-- The design doc's risk section plans for a pre-computed recommendation as
-- a stage fallback. This seed is what makes that rehearsable: the tie is
-- real (the tally genuinely computes 2.0 vs 2.0), not faked in the UI.
--
-- Assumes users/cities from the provided CSVs are already loaded. Adjust
-- the user_ids below to real ones from your `users` table.

BEGIN;

\set trip_id      'trip_demo_varanasi'
\set itin_id      'itin_demo_varanasi'
\set owner_id     'usr_00001'
\set member_b     'usr_00002'
\set member_c     'usr_00003'
\set member_d     'usr_00004'

INSERT INTO trips (
  trip_id, owner_user_id, title, origin_city_id, destination_city_id,
  start_date, end_date, party_size, adults, children, trip_type,
  is_group_trip, status, home_currency, notes, created_at, updated_at
)
SELECT :'trip_id', :'owner_id', 'Varanasi, four of us',
       NULL, c.city_id, '2027-03-10', '2027-03-15', 6, 4, 0, 'friends',
       true, 'planning', 'INR', 'Seeded for the consensus demo.', now(), now()
  FROM cities c WHERE c.name ILIKE 'Varanasi' LIMIT 1
ON CONFLICT (trip_id) DO NOTHING;

INSERT INTO trip_members (member_id, trip_id, user_id, role, joined_at, share_weight, invited_by_user_id, status, updated_at)
VALUES
  ('mem_demo_a', :'trip_id', :'owner_id', 'owner',  now(), 1, NULL,        'active', now()),
  ('mem_demo_b', :'trip_id', :'member_b', 'editor', now(), 1, :'owner_id', 'active', now()),
  ('mem_demo_c', :'trip_id', :'member_c', 'editor', now(), 1, :'owner_id', 'active', now()),
  ('mem_demo_d', :'trip_id', :'member_d', 'viewer', now(), 1, :'owner_id', 'active', now())
ON CONFLICT (trip_id, user_id) DO NOTHING;

INSERT INTO itineraries (
  itinerary_id, trip_id, name, version, is_active, generated_by,
  total_cost, currency, total_duration_minutes, total_carbon_kg,
  status, created_at, updated_at
) VALUES (
  :'itin_id', :'trip_id', 'Varanasi plan', 1, true, 'user',
  0, 'INR', 0, 0, 'active', now(), now()
) ON CONFLICT (itinerary_id) DO NOTHING;

INSERT INTO itinerary_items (
  item_id, itinerary_id, day_index, sort_order, item_type, title,
  cost, currency, carbon_kg, duration_minutes, source, locked, status,
  created_at, updated_at
) VALUES
  ('item_demo_aarti', :'itin_id', 1, 0, 'poi', 'Ganga Aarti at Dashashwamedh',
   0, 'INR', 0, 90, 'user', false, 'confirmed', now(), now()),
  ('item_demo_chhatri', :'itin_id', 2, 0, 'poi', 'Chhatri Complex visit',
   300, 'INR', 0, 120, 'user', false, 'confirmed', now(), now())
ON CONFLICT (item_id) DO NOTHING;

-- The contested change. closes_at is already in the past so the tally is
-- immediately resolvable — the demo does not wait 24 hours.
INSERT INTO proposals (
  proposal_id, itinerary_id, proposed_by_user_id, action, target_item_id,
  title, rationale, cost_delta, currency, closes_at, status, created_at, updated_at
) VALUES (
  'prop_demo_ridge', :'itin_id', :'member_b', 'replace', 'item_demo_chhatri',
  'Ridge Lookout instead of the Chhatri Complex',
  'Better light for photos and a shorter walk from the ghats.',
  450, 'INR', now() - INTERVAL '1 minute', 'open', now() - INTERVAL '2 hours', now()
) ON CONFLICT (proposal_id) DO NOTHING;

-- 2 yes vs 2 no at equal weight: a genuine, honestly-computed tie.
INSERT INTO votes (vote_id, proposal_id, user_id, value, weight, comment, cast_at, updated_at)
VALUES
  ('vote_demo_1','prop_demo_ridge', :'member_b', 'yes', 1,
   'The views from the ridge are much better at golden hour.', now(), now()),
  ('vote_demo_2','prop_demo_ridge', :'member_c', 'yes', 1,
   'Shorter walk works better for me.', now(), now()),
  ('vote_demo_3','prop_demo_ridge', :'owner_id', 'no', 1,
   'We came for the heritage, the Chhatri Complex is the reason I picked Varanasi.', now(), now()),
  ('vote_demo_4','prop_demo_ridge', :'member_d', 'no', 1,
   'I would rather keep the original plan, but I am not strongly against.', now(), now())
ON CONFLICT (proposal_id, user_id) DO NOTHING;

INSERT INTO face_consents (consent_id, trip_id, user_id, granted, granted_at, updated_at)
VALUES ('consent_demo_a', :'trip_id', :'owner_id', true, now(), now())
ON CONFLICT (trip_id, user_id) DO NOTHING;

COMMIT;

-- Sanity check the tie actually exists:
--   SELECT value, SUM(weight) FROM votes
--    WHERE proposal_id='prop_demo_ridge' GROUP BY value;
--   -> yes 2.00 / no 2.00
