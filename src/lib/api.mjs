/**
 * Platform-agnostic API core.
 *
 * Everything here speaks plain objects, so the Netlify function, a Vercel
 * function and the local dev server can all share exactly the same routes.
 * Nothing in here is ever sent to the browser except the JSON it returns —
 * the database credentials stay on the server.
 */
import { query, withTransaction } from './db.mjs';
import { CARD_IDS, CARDS } from './cards.mjs';
import { optimizeTrades } from './optimizer.mjs';

const SORTED_CARD_IDS = [...CARD_IDS].sort((a, b) => a - b);
// Cards can only be swapped against cards from the same group.
const CARD_CATEGORY = new Map(CARDS.map((c) => [c.id, c.category]));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ApiError extends Error {
  constructor(status, message, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ok = (body, status = 200) => ({ status, body });

const ROUTES = [
  ['POST', /^\/clans$/, createClan],
  ['GET', /^\/clans\/([^/]+)$/, getClan],
  ['PATCH', /^\/clans\/([^/]+)$/, renameClan],
  ['POST', /^\/clans\/([^/]+)\/members$/, addMember],
  ['PATCH', /^\/clans\/([^/]+)\/members\/([^/]+)$/, renameMember],
  ['DELETE', /^\/clans\/([^/]+)\/members\/([^/]+)$/, removeMember],
  ['PUT', /^\/clans\/([^/]+)\/members\/([^/]+)\/cards$/, replaceCards],
  ['PATCH', /^\/clans\/([^/]+)\/members\/([^/]+)\/cards$/, updateCard],
  ['GET', /^\/health$/, health],
];

/**
 * @param {{method: string, path: string, body?: any}} request
 * @returns {Promise<{status: number, body: any, headers?: Record<string,string>}>}
 */
export async function handleApiRequest({ method, path, body }) {
  const clean = ('/' + String(path || '').replace(/^\/+|\/+$/g, '')).replace(/\/+/g, '/');

  if (method === 'OPTIONS') return { status: 204, body: null };

  // Several routes share a path with different methods (PUT vs PATCH on
  // /cards), so check every pattern before deciding it is a 404 or a 405.
  let pathExists = false;
  for (const [routeMethod, pattern, handler] of ROUTES) {
    const match = clean.match(pattern);
    if (!match) continue;
    pathExists = true;
    if (routeMethod !== method) continue;
    try {
      return await handler(match.slice(1), body ?? {});
    } catch (err) {
      return fail(err);
    }
  }

  if (pathExists) return fail(new ApiError(405, `${method} is not allowed on ${clean}`));
  return fail(new ApiError(404, `No route for ${method} ${clean}`, 'not_found'));
}

function fail(err) {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: err.message, code: err.code } };
  }
  // Postgres constraint violations get friendly wording; everything else is a bug.
  if (err?.code === '23505') {
    return { status: 409, body: { error: 'That name is already taken in this clan.', code: 'duplicate' } };
  }
  if (err?.code === '23514') {
    return { status: 400, body: { error: 'That value is out of range.', code: 'invalid' } };
  }
  console.error('[api] unhandled error', err);
  return { status: 500, body: { error: 'Something went wrong on our side.', code: 'server_error' } };
}

// --- helpers ---------------------------------------------------------------

function requireUuid(value, what) {
  if (!UUID_RE.test(String(value || ''))) throw new ApiError(404, `${what} not found`, 'not_found');
  return value;
}

function cleanName(value, what, max) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new ApiError(400, `${what} can't be empty.`, 'invalid');
  if (name.length > max) throw new ApiError(400, `${what} is too long (max ${max}).`, 'invalid');
  return name;
}

function cleanCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 99) {
    throw new ApiError(400, 'Card counts must be between 0 and 99.', 'invalid');
  }
  return Math.floor(n);
}

async function loadClanOr404(clanId) {
  requireUuid(clanId, 'Clan');
  const { rows } = await query('select id, name, created_at, updated_at from clans where id = $1', [
    clanId,
  ]);
  if (!rows.length) throw new ApiError(404, 'This clan link is not valid (any more).', 'not_found');
  return rows[0];
}

async function assertMemberInClan(clanId, memberId) {
  requireUuid(memberId, 'Member');
  const { rows } = await query('select id, name from members where id = $1 and clan_id = $2', [
    memberId,
    clanId,
  ]);
  if (!rows.length) throw new ApiError(404, 'That member is not in this clan.', 'not_found');
  return rows[0];
}

const touchClan = (clanId) => query('update clans set updated_at = now() where id = $1', [clanId]);

// --- handlers --------------------------------------------------------------

async function health() {
  const { rows } = await query('select now() as at');
  return ok({ ok: true, at: rows[0].at });
}

async function createClan(_params, body) {
  const name = cleanName(body.name, 'Clan name', 60);
  const { rows } = await query(
    'insert into clans (name) values ($1) returning id, name, created_at, updated_at',
    [name],
  );
  return ok({ clan: shapeClan(rows[0]) }, 201);
}

async function renameClan([clanId], body) {
  await loadClanOr404(clanId);
  const name = cleanName(body.name, 'Clan name', 60);
  const { rows } = await query(
    'update clans set name = $2, updated_at = now() where id = $1 returning id, name, created_at, updated_at',
    [clanId, name],
  );
  return ok({ clan: shapeClan(rows[0]) });
}

// Every client polls this endpoint, so the plan is memoised per data version:
// any write bumps a member's or the clan's updated_at, which changes the key.
const planCache = new Map();
const PLAN_CACHE_MAX = 40;

function cachedPlan(key, members) {
  const hit = planCache.get(key);
  if (hit) return hit;
  const plan = optimizeTrades(members, {
    cardIds: SORTED_CARD_IDS,
    categoryOf: CARD_CATEGORY,
  });
  if (planCache.size >= PLAN_CACHE_MAX) planCache.delete(planCache.keys().next().value);
  planCache.set(key, plan);
  return plan;
}

/** The single read the app runs on: clan, everyone's cards, and the trade plan. */
async function getClan([clanId]) {
  const clan = await loadClanOr404(clanId);

  const { rows } = await query(
    `select m.id, m.name, m.created_at, m.updated_at,
            coalesce(
              jsonb_object_agg(mc.card_id, mc.count) filter (where mc.card_id is not null),
              '{}'::jsonb
            ) as counts
       from members m
       left join member_cards mc on mc.member_id = m.id and mc.count > 0
      where m.clan_id = $1
      group by m.id
      order by lower(m.name)`,
    [clanId],
  );

  const members = rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    counts: normalizeCounts(r.counts),
  }));

  const version = [
    clanId,
    clan.updated_at?.toISOString?.() ?? clan.updated_at,
    ...rows.map((r) => `${r.id}:${r.updated_at?.toISOString?.() ?? r.updated_at}`),
  ].join('|');
  const plan = cachedPlan(version, members);

  return ok({
    clan: shapeClan(clan),
    members: members.map((m) => ({ ...m, summary: summarize(m.counts) })),
    plan,
    generatedAt: new Date().toISOString(),
  });
}

async function addMember([clanId], body) {
  await loadClanOr404(clanId);
  const name = cleanName(body.name, 'Your name', 40);

  const existing = await query(
    'select id, name from members where clan_id = $1 and lower(btrim(name)) = lower($2)',
    [clanId, name],
  );
  if (existing.rows.length) {
    if (!body.claimExisting) {
      throw new ApiError(
        409,
        `"${existing.rows[0].name}" is already on the list. If that's you, open it — otherwise pick another name.`,
        'duplicate',
      );
    }
    return ok({ member: { ...shapeMember(existing.rows[0]), counts: {} }, claimed: true });
  }

  const { rows } = await query(
    'insert into members (clan_id, name) values ($1, $2) returning id, name, created_at, updated_at',
    [clanId, name],
  );
  await touchClan(clanId);
  return ok({ member: { ...shapeMember(rows[0]), counts: {} } }, 201);
}

async function renameMember([clanId, memberId], body) {
  await loadClanOr404(clanId);
  await assertMemberInClan(clanId, memberId);
  const name = cleanName(body.name, 'Name', 40);
  const { rows } = await query(
    'update members set name = $3, updated_at = now() where id = $1 and clan_id = $2 returning id, name, created_at, updated_at',
    [memberId, clanId, name],
  );
  await touchClan(clanId);
  return ok({ member: shapeMember(rows[0]) });
}

async function removeMember([clanId, memberId]) {
  await loadClanOr404(clanId);
  await assertMemberInClan(clanId, memberId);
  await query('delete from members where id = $1 and clan_id = $2', [memberId, clanId]);
  await touchClan(clanId);
  return ok({ removed: memberId });
}

/** Replaces a member's whole collection — used by the "paste your counts" flow. */
async function replaceCards([clanId, memberId], body) {
  await loadClanOr404(clanId);
  await assertMemberInClan(clanId, memberId);

  const counts = body?.counts;
  if (!counts || typeof counts !== 'object') {
    throw new ApiError(400, 'Send a counts object, e.g. { "1": 2, "24": 0 }.', 'invalid');
  }

  const pairs = [];
  for (const [rawId, rawCount] of Object.entries(counts)) {
    const cardId = Number(rawId);
    if (!CARD_IDS.has(cardId)) throw new ApiError(400, `Unknown card id: ${rawId}`, 'invalid');
    const count = cleanCount(rawCount);
    if (count > 0) pairs.push([cardId, count]);
  }

  await withTransaction(async (client) => {
    await client.query('delete from member_cards where member_id = $1', [memberId]);
    if (pairs.length) {
      await client.query(
        `insert into member_cards (member_id, card_id, count)
         select $1, * from unnest($2::smallint[], $3::smallint[])`,
        [memberId, pairs.map((p) => p[0]), pairs.map((p) => p[1])],
      );
    }
    await client.query('update members set updated_at = now() where id = $1', [memberId]);
  });
  await touchClan(clanId);

  return ok({ memberId, counts: Object.fromEntries(pairs) });
}

/** Single-cell update — what the grid fires on every tap. */
async function updateCard([clanId, memberId], body) {
  await loadClanOr404(clanId);
  await assertMemberInClan(clanId, memberId);

  const cardId = Number(body.cardId);
  if (!CARD_IDS.has(cardId)) throw new ApiError(400, `Unknown card id: ${body.cardId}`, 'invalid');
  const count = cleanCount(body.count);

  if (count === 0) {
    await query('delete from member_cards where member_id = $1 and card_id = $2', [memberId, cardId]);
  } else {
    await query(
      `insert into member_cards (member_id, card_id, count) values ($1, $2, $3)
       on conflict (member_id, card_id) do update set count = excluded.count, updated_at = now()`,
      [memberId, cardId, count],
    );
  }
  await query('update members set updated_at = now() where id = $1', [memberId]);
  await touchClan(clanId);

  return ok({ memberId, cardId, count });
}

// --- shaping ---------------------------------------------------------------

const shapeClan = (row) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const shapeMember = (row) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function normalizeCounts(raw) {
  const counts = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const id = Number(k);
    const n = Number(v);
    if (CARD_IDS.has(id) && n > 0) counts[id] = n;
  }
  return counts;
}

function summarize(counts) {
  let owned = 0;
  let spares = 0;
  for (const id of CARD_IDS) {
    const n = counts[id] || 0;
    if (n > 0) owned++;
    if (n > 1) spares += n - 1;
  }
  return { owned, missing: CARD_IDS.size - owned, spares, total: CARD_IDS.size };
}
