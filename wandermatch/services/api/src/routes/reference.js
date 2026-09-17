/**
 * Read-only reference data: cities, currencies, languages, guides.
 * Cached hard — this data changes approximately never during a hackathon.
 */
import { pool } from '../db/pool.js';

export default async function referenceRoutes(fastify) {
  fastify.get('/reference/cities', { config: { public: true } }, async request => {
    const q = String(request.query.q ?? '').trim();
    const { rows } = await pool.query(
      `SELECT city_id, name, state, country_code, lat, lng, season_profile,
              peak_months, primary_language, description
         FROM cities
        WHERE status = 'active'
          AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR state ILIKE '%' || $1 || '%')
        ORDER BY population DESC NULLS LAST
        LIMIT 40`,
      [q]
    );
    return { cities: rows };
  });

  fastify.get('/reference/languages', { config: { public: true } }, async () => {
    const { rows } = await pool.query(
      `SELECT language_id, bcp47, english_name, native_name, rtl
         FROM languages ORDER BY english_name`
    );
    return { languages: rows };
  });

  fastify.get('/reference/currencies', { config: { public: true } }, async () => {
    const { rows } = await pool.query(
      `SELECT currency_id, iso4217, name, symbol, minor_unit_exponent, display_locale
         FROM currencies ORDER BY iso4217`
    );
    return { currencies: rows };
  });

  /**
   * Guides are listed and filterable but NOT bookable — booking belongs to
   * PS-04 (design doc §3, "deliberately left out").
   */
  fastify.get('/reference/guides', async request => {
    const { cityId, language, specialisation, maxDayRate } = request.query;
    const { rows } = await pool.query(
      `SELECT guide_id, city_id, display_name, languages, specialisation,
              secondary_specialisation, years_experience, rating, review_count,
              day_rate, half_day_rate, currency, certified, bio
         FROM tour_guides
        WHERE status = 'active'
          AND ($1::text IS NULL OR city_id = $1)
          AND ($2::text IS NULL OR languages ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR specialisation = $3 OR secondary_specialisation = $3)
          AND ($4::numeric IS NULL OR day_rate <= $4)
        ORDER BY certified DESC, rating DESC NULLS LAST, review_count DESC
        LIMIT 50`,
      [cityId ?? null, language ?? null, specialisation ?? null, maxDayRate ?? null]
    );
    return { guides: rows, bookable: false };
  });
}
