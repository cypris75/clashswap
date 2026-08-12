import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeTrades } from '../src/lib/optimizer.mjs';
import { CARDS } from '../src/lib/cards.mjs';

const m = (id, counts) => ({ id, name: id, counts });

/** Exhaustive search over swap sequences — only viable for tiny inputs. */
function bruteForce(members, cardIds, categoryOf = null) {
  const sameGroup = (x, y) => !categoryOf || categoryOf[x] === categoryOf[y];
  const state = members.map((mem) => ({
    id: mem.id,
    spare: Object.fromEntries(cardIds.map((k) => [k, Math.max(0, (mem.counts[k] || 0) - 1)])),
    need: Object.fromEntries(cardIds.map((k) => [k, (mem.counts[k] || 0) === 0])),
  }));

  let best = 0;
  const seen = new Set();
  const key = (s) => s.map((x) => cardIds.map((k) => `${x.spare[k]}${x.need[k] ? 'n' : '.'}`).join('')).join('|');

  (function search(s, depth) {
    const k = key(s);
    if (seen.has(k)) return;
    seen.add(k);
    best = Math.max(best, depth);
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j++) {
        for (const x of cardIds) {
          if (!(s[i].spare[x] > 0 && s[j].need[x])) continue;
          for (const y of cardIds) {
            if (!(s[j].spare[y] > 0 && s[i].need[y])) continue;
            if (!sameGroup(x, y)) continue;
            const next = s.map((p) => ({ id: p.id, spare: { ...p.spare }, need: { ...p.need } }));
            next[i].spare[x]--;
            next[j].need[x] = false;
            next[j].spare[y]--;
            next[i].need[y] = false;
            search(next, depth + 1);
          }
        }
      }
    }
  })(state, 0);

  return best;
}

/** Replays a plan against the starting counts to prove every swap is legal. */
function validate(members, result, categoryOf = null) {
  const st = new Map(
    members.map((mem) => [mem.id, { counts: { ...mem.counts } }]),
  );
  for (const t of result.trades) {
    if (categoryOf) {
      assert.equal(
        categoryOf[t.aGives],
        categoryOf[t.bGives],
        `swap ${t.aGives} ⇄ ${t.bGives} crosses groups`,
      );
    }
    const a = st.get(t.a);
    const b = st.get(t.b);
    assert.ok(a && b, 'trade references a known member');
    assert.notEqual(t.a, t.b, 'nobody trades with themselves');
    assert.ok((a.counts[t.aGives] || 0) >= 2, `${t.a} has a spare ${t.aGives}`);
    assert.equal(b.counts[t.aGives] || 0, 0, `${t.b} is missing ${t.aGives}`);
    assert.ok((b.counts[t.bGives] || 0) >= 2, `${t.b} has a spare ${t.bGives}`);
    assert.equal(a.counts[t.bGives] || 0, 0, `${t.a} is missing ${t.bGives}`);
    a.counts[t.aGives]--;
    b.counts[t.aGives] = 1;
    b.counts[t.bGives]--;
    a.counts[t.bGives] = 1;
  }
  return result.trades.length;
}

test('the two-player example: my spare for the one I am missing', () => {
  // Two Elixir Troops, so this is a legal swap.
  const categoryOf = { 1: 0, 3: 0 };
  const members = [m('me', { 1: 2, 3: 0 }), m('other', { 1: 0, 3: 2 })];
  const r = optimizeTrades(members, { cardIds: [1, 3], categoryOf });
  assert.equal(r.stats.trades, 1);
  assert.equal(r.stats.optimal, true);
  validate(members, r, categoryOf);
  const t = r.trades[0];
  assert.deepEqual([t.aGives, t.bGives].sort(), [1, 3]);
  assert.equal(r.byMember.me.length, 1);
  assert.equal(r.byMember.me[0].give, 1);
  assert.equal(r.byMember.me[0].get, 3);
});

test('no trade when the swap is only one-directional', () => {
  // "me" has a spare the other needs, but has nothing to receive in return.
  const members = [m('me', { 1: 2, 24: 1 }), m('other', { 1: 0, 24: 1 })];
  const r = optimizeTrades(members, { cardIds: [1, 24] });
  assert.equal(r.stats.trades, 0);
  assert.deepEqual(r.leftovers.me.unmatchedSpares, [1]);
});

test('a second copy of an already-received card is never handed over twice', () => {
  // Two members both hold three Barbarians; one Barbarian each is all that moves.
  const members = [m('a', { 1: 3, 2: 0 }), m('b', { 1: 0, 2: 3 })];
  const r = optimizeTrades(members, { cardIds: [1, 2] });
  assert.equal(r.stats.trades, 1);
  validate(members, r);
});

test('matches brute force on 300 random small clans', () => {
  let rng = 12345;
  const rand = (nMax) => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng % nMax;
  };
  const cardIds = [1, 2, 3, 4];
  let checked = 0;
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + rand(3); // 2–4 members
    const members = [];
    for (let i = 0; i < n; i++) {
      const counts = {};
      for (const k of cardIds) counts[k] = rand(3); // 0, 1 or 2 copies
      members.push(m(`p${i}`, counts));
    }
    const r = optimizeTrades(members, { cardIds, timeBudgetMs: 15 });
    validate(members, r);
    const optimum = bruteForce(members, cardIds);
    assert.equal(
      r.stats.trades,
      optimum,
      `trial ${trial}: got ${r.stats.trades}, optimum ${optimum}\n${JSON.stringify(members)}`,
    );
    checked++;
  }
  assert.equal(checked, 300);
});

test('never swaps across groups', () => {
  // Thrower (Elixir) against Druid (Dark Elixir) is not a legal trade in game.
  const categoryOf = { 18: 0, 30: 1 };
  const members = [m('a', { 18: 2, 30: 0 }), m('b', { 18: 0, 30: 2 })];

  const unrestricted = optimizeTrades(members, { cardIds: [18, 30], timeBudgetMs: 15 });
  assert.equal(unrestricted.stats.trades, 1, 'without groups this pairing is fine');

  const r = optimizeTrades(members, { cardIds: [18, 30], categoryOf, timeBudgetMs: 15 });
  assert.equal(r.stats.trades, 0, 'Thrower ⇄ Druid must not be proposed');
  assert.equal(r.stats.upperBound, 0, 'and the bound knows it is impossible');
  assert.deepEqual(r.leftovers.a.unmatchedSpares, [18]);
  assert.deepEqual(r.leftovers.a.stillMissing, [30]);
});

test('still trades freely inside one group', () => {
  const categoryOf = { 1: 0, 3: 0, 24: 1, 30: 1 };
  const members = [
    m('a', { 1: 2, 3: 0, 24: 2, 30: 0 }),
    m('b', { 1: 0, 3: 2, 24: 0, 30: 2 }),
  ];
  const r = optimizeTrades(members, { cardIds: [1, 3, 24, 30], categoryOf, timeBudgetMs: 20 });
  assert.equal(r.stats.trades, 2, 'one Elixir swap and one Dark Elixir swap');
  assert.equal(r.stats.optimal, true);
  validate(members, r, categoryOf);
});

test('matches brute force on 300 random grouped clans', () => {
  let rng = 777;
  const rand = (nMax) => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng % nMax;
  };
  const cardIds = [1, 2, 3, 4, 5, 6];
  const categoryOf = { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1 };
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + rand(3);
    const members = [];
    for (let i = 0; i < n; i++) {
      const counts = {};
      for (const k of cardIds) counts[k] = rand(3);
      members.push(m(`p${i}`, counts));
    }
    const r = optimizeTrades(members, { cardIds, categoryOf, timeBudgetMs: 15 });
    validate(members, r, categoryOf);
    assert.equal(
      r.stats.trades,
      bruteForce(members, cardIds, categoryOf),
      `trial ${trial}: ${JSON.stringify(members)}`,
    );
  }
});

test('handles a full 50-member clan quickly and legally', () => {
  const cardIds = CARDS.map((c) => c.id).sort((a, b) => a - b);
  const categoryOf = Object.fromEntries(CARDS.map((c) => [c.id, c.category]));
  let rng = 99;
  const rand = (nMax) => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng % nMax;
  };
  const members = [];
  for (let i = 0; i < 50; i++) {
    const counts = {};
    for (const k of cardIds) {
      const roll = rand(10);
      counts[k] = roll < 4 ? 0 : roll < 8 ? 1 : roll === 8 ? 2 : 3;
    }
    members.push(m(`p${i}`, counts));
  }
  const started = performance.now();
  const r = optimizeTrades(members, { cardIds, categoryOf });
  const ms = performance.now() - started;
  validate(members, r, categoryOf);
  assert.ok(r.stats.trades > 0);
  assert.ok(ms < 4000, `optimizer took ${ms.toFixed(0)}ms`);
  console.log(
    `  50 members: ${r.stats.trades} trades (bound ${r.stats.upperBound}) in ${ms.toFixed(0)}ms`,
  );
});

test('empty and single-member clans return an empty plan', () => {
  assert.equal(optimizeTrades([]).stats.trades, 0);
  assert.equal(optimizeTrades([m('solo', { 1: 5 })]).stats.trades, 0);
});
