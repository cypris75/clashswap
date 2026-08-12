/**
 * API round-trip tests. They talk to the real database, so they are skipped
 * unless DATABASE_URL is set (npm test picks it up from .env automatically).
 * Everything created here is deleted again at the end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../scripts/load-env.mjs';

loadEnv();

const hasDb = Boolean(process.env.DATABASE_URL);
const { handleApiRequest } = hasDb ? await import('../src/lib/api.mjs') : {};
const { getPool } = hasDb ? await import('../src/lib/db.mjs') : {};

const call = (method, path, body) => handleApiRequest({ method, path, body });

test('API round trip', { skip: hasDb ? false : 'DATABASE_URL not set' }, async (t) => {
  let clanId;
  let alice;
  let bob;

  t.after(async () => {
    if (clanId) await getPool().query('delete from clans where id = $1', [clanId]);
    await getPool().end();
  });

  await t.test('creates a clan with an unguessable id', async () => {
    const res = await call('POST', '/clans', { name: '  Test Clan  ' });
    assert.equal(res.status, 201);
    assert.match(res.body.clan.id, /^[0-9a-f-]{36}$/);
    assert.equal(res.body.clan.name, 'Test Clan', 'name is trimmed');
    clanId = res.body.clan.id;
  });

  await t.test('rejects an empty clan name', async () => {
    const res = await call('POST', '/clans', { name: '   ' });
    assert.equal(res.status, 400);
  });

  await t.test('unknown clan ids 404 instead of leaking anything', async () => {
    assert.equal((await call('GET', '/clans/not-a-uuid')).status, 404);
    assert.equal(
      (await call('GET', '/clans/11111111-2222-3333-4444-555555555555')).status,
      404,
    );
  });

  await t.test('adds members and refuses duplicate names', async () => {
    const a = await call('POST', `/clans/${clanId}/members`, { name: 'Alice' });
    assert.equal(a.status, 201);
    alice = a.body.member.id;

    const b = await call('POST', `/clans/${clanId}/members`, { name: 'Bob' });
    bob = b.body.member.id;

    const dup = await call('POST', `/clans/${clanId}/members`, { name: 'alice' });
    assert.equal(dup.status, 409, 'case-insensitive duplicate is rejected');

    const claimed = await call('POST', `/clans/${clanId}/members`, {
      name: 'ALICE',
      claimExisting: true,
    });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.member.id, alice, 'claiming returns the existing member');
  });

  await t.test('saves single cards and whole collections', async () => {
    // PUT and PATCH share a path — the router must not confuse them.
    const put = await call('PUT', `/clans/${clanId}/members/${alice}/cards`, {
      counts: { 1: 2, 24: 0, 40: 1 },
    });
    assert.equal(put.status, 200);

    const patch = await call('PATCH', `/clans/${clanId}/members/${alice}/cards`, {
      cardId: 7,
      count: 3,
    });
    assert.equal(patch.status, 200);

    const { body } = await call('GET', `/clans/${clanId}`);
    const stored = body.members.find((m) => m.id === alice).counts;
    assert.deepEqual(stored, { 1: 2, 7: 3, 40: 1 }, 'zeroes are not stored');
  });

  await t.test('rejects impossible card data', async () => {
    const badCard = await call('PATCH', `/clans/${clanId}/members/${alice}/cards`, {
      cardId: 999,
      count: 1,
    });
    assert.equal(badCard.status, 400);

    const badCount = await call('PATCH', `/clans/${clanId}/members/${alice}/cards`, {
      cardId: 1,
      count: -4,
    });
    assert.equal(badCount.status, 400);
  });

  await t.test('members of other clans are not writable through this clan', async () => {
    const other = await call('POST', '/clans', { name: 'Other Clan' });
    const outsider = await call('POST', `/clans/${other.body.clan.id}/members`, {
      name: 'Mallory',
    });
    const res = await call('PATCH', `/clans/${clanId}/members/${outsider.body.member.id}/cards`, {
      cardId: 1,
      count: 1,
    });
    assert.equal(res.status, 404);
    await getPool().query('delete from clans where id = $1', [other.body.clan.id]);
  });

  await t.test('computes a trade plan', async () => {
    // Alice holds 2 Barbarians and no Giant; Bob is the mirror image.
    // Both are Elixir Troops, so the swap is legal.
    await call('PUT', `/clans/${clanId}/members/${alice}/cards`, { counts: { 1: 2 } });
    await call('PUT', `/clans/${clanId}/members/${bob}/cards`, { counts: { 3: 2 } });

    const { body } = await call('GET', `/clans/${clanId}`);
    assert.equal(body.plan.stats.trades, 1);
    assert.equal(body.plan.stats.optimal, true);

    const mine = body.plan.byMember[alice];
    assert.equal(mine.length, 1);
    assert.equal(mine[0].give, 1, 'Alice gives the Barbarian');
    assert.equal(mine[0].get, 3, 'Alice gets the Giant');
    assert.equal(mine[0].partner, bob);
  });

  await t.test('does not propose swaps across card groups', async () => {
    // Barbarian is an Elixir Troop, Witch a Dark Elixir Troop — not tradable.
    await call('PUT', `/clans/${clanId}/members/${alice}/cards`, { counts: { 1: 2 } });
    await call('PUT', `/clans/${clanId}/members/${bob}/cards`, { counts: { 24: 2 } });

    const { body } = await call('GET', `/clans/${clanId}`);
    assert.equal(body.plan.stats.trades, 0);
    assert.deepEqual(body.plan.leftovers[alice].unmatchedSpares, [1]);
  });

  await t.test('removes a member', async () => {
    const res = await call('DELETE', `/clans/${clanId}/members/${bob}`);
    assert.equal(res.status, 200);
    const { body } = await call('GET', `/clans/${clanId}`);
    assert.equal(body.members.length, 1);
    assert.equal(body.plan.stats.trades, 0);
  });

  await t.test('answers 404 for unknown paths and 405 for wrong methods', async () => {
    assert.equal((await call('GET', '/nope')).status, 404);
    assert.equal((await call('DELETE', '/clans')).status, 405);
  });
});
