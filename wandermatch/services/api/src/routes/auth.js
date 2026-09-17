/**
 * Auth. Argon2id for password hashing — memory-hard, so a leaked table is
 * expensive to attack offline, which bcrypt no longer reliably is.
 *
 * Note on the provided schema: `users` has no password column, and Rule R1
 * forbids adding one to a provided table. Credentials therefore live in a
 * separate additive table, which is better practice anyway — the auth
 * secret and the profile have different access patterns and blast radius.
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import argon2 from 'argon2';
import { pool, withTransaction } from '../db/pool.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';

const ARGON_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456,   // 19 MiB — OWASP minimum
  timeCost: 2,
  parallelism: 1
};

export default async function authRoutes(fastify) {
  fastify.post('/auth/signup', { config: { public: true } }, async (request, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(10).max(200),
      displayName: z.string().min(1).max(80),
      homeCityId: z.string().default('city_bengaluru'),
      locale: z.string().default('en-IN')
    }).parse(request.body);

    const existing = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [body.email]);
    if (existing.rows.length > 0) {
      throw new ValidationError('An account with that email already exists.');
    }

    const hash = await argon2.hash(body.password, ARGON_OPTS);
    const userId = ulid();

    await withTransaction(async c => {
      await c.query(
        `INSERT INTO users (
           user_id, display_name, email, home_city_id, home_currency, locale,
           budget_band, travel_style, traveller_type, segment, date_of_signup,
           status, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,'INR',$5,'mid','comfort','friends','cold_start',
                   CURRENT_DATE,'active',now(),now())`,
        [userId, body.displayName, body.email, body.homeCityId, body.locale]
      );
      await c.query(
        `INSERT INTO auth_credentials (user_id, password_hash, created_at, updated_at)
         VALUES ($1,$2,now(),now())`,
        [userId, hash]
      );
    });

    const token = fastify.jwt.sign({ sub: userId, name: body.displayName, locale: body.locale });
    reply.code(201);
    return { token, user: { userId, displayName: body.displayName, locale: body.locale } };
  });

  fastify.post('/auth/login', { config: { public: true } }, async request => {
    const body = z.object({
      email: z.string().email(),
      password: z.string()
    }).parse(request.body);

    const { rows } = await pool.query(
      `SELECT u.user_id, u.display_name, u.locale, u.status, ac.password_hash
         FROM users u JOIN auth_credentials ac ON ac.user_id = u.user_id
        WHERE u.email = $1`,
      [body.email]
    );

    // Constant-ish work on the miss path too, so response timing does not
    // reveal whether an email is registered.
    if (rows.length === 0) {
      await argon2.hash(body.password, ARGON_OPTS).catch(() => {});
      throw new UnauthorizedError('Email or password is incorrect.');
    }

    const user = rows[0];
    const ok = await argon2.verify(user.password_hash, body.password).catch(() => false);
    if (!ok || user.status !== 'active') {
      throw new UnauthorizedError('Email or password is incorrect.');
    }

    const token = fastify.jwt.sign({
      sub: user.user_id, name: user.display_name, locale: user.locale
    });
    return {
      token,
      user: { userId: user.user_id, displayName: user.display_name, locale: user.locale }
    };
  });

  fastify.get('/auth/me', async request => {
    const { rows } = await pool.query(
      `SELECT u.user_id, u.display_name, u.email, u.locale, u.budget_band,
              u.travel_style, u.traveller_type, up.interests, up.pace,
              up.max_daily_budget, up.preferred_currency
         FROM users u LEFT JOIN user_preferences up ON up.user_id = u.user_id
        WHERE u.user_id = $1`,
      [request.user.sub]
    );
    if (rows.length === 0) throw new UnauthorizedError();
    return { user: rows[0] };
  });
}
