/**
 * Trade optimizer for Clash of Clans card swaps.
 *
 * Rules of the game we model:
 *  - A member "needs" a card when they own 0 of it. Owning it once is enough; a
 *    second copy is a spare.
 *  - Every trade is a straight 1-for-1 swap between two members: A hands B a
 *    spare B is missing, and B hands A a spare A is missing, in the same deal.
 *  - Both cards in a swap must belong to the same group (Elixir Troops, Dark
 *    Elixir Troops, Builder Base Troops, Super Troops). The game does not allow
 *    trading across groups, so each group is solved as its own little market.
 *  - Each spare copy can only be given away once, and each missing card only
 *    needs to be filled once.
 *
 * Maximising the number of such swaps is a matching problem over shared
 * resources (NP-hard in general), so we run a scarcity-first greedy — always
 * execute the swap whose four consumed resources (two spares, two gaps) have
 * the fewest alternative uses left — and then improve it with ruin & recreate:
 * tear out a handful of swaps at random, rebuild greedily with noise, keep the
 * result if it is no worse. `stats.upperBound` carries the theoretical ceiling
 * so the UI can say whether a plan is provably optimal.
 */

const FAIRNESS_WEIGHT = 0.35; // nudges swaps towards members with fewer trades
const DEFAULT_TIME_BUDGET_MS = 400;

/** Deterministic PRNG so identical input always yields an identical plan. */
function makeRandom(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * @param {Array<{id: string, name?: string, counts: Record<string|number, number>}>} members
 * @param {{
 *   cardIds?: number[],
 *   categoryOf?: Record<string|number, number> | Map<number, number>,
 *   timeBudgetMs?: number,
 *   seed?: number,
 * }} [options] `categoryOf` maps a card id to its group; cards may only be
 *   swapped against cards in the same group. Omit it to allow any pairing.
 */
export function optimizeTrades(members, options = {}) {
  const cardIds = options.cardIds ?? collectCardIds(members);
  const timeBudget = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const n = members.length;
  const c = cardIds.length;

  if (n === 0 || c === 0) {
    return {
      trades: [],
      byMember: Object.fromEntries(members.map((m) => [m.id, []])),
      leftovers: Object.fromEntries(
        members.map((m) => [m.id, { unmatchedSpares: [], stillMissing: [] }]),
      ),
      stats: {
        trades: 0,
        cardsMoved: 0,
        upperBound: 0,
        optimal: true,
        membersTrading: 0,
        iterations: 0,
      },
    };
  }

  // --- starting position ---------------------------------------------------
  const spare0 = new Int32Array(n * c); // copies beyond the first
  const need0 = new Uint8Array(n * c); // 1 when the member owns none
  for (let i = 0; i < n; i++) {
    const counts = members[i].counts || {};
    for (let k = 0; k < c; k++) {
      const raw = Number(counts[cardIds[k]] ?? counts[String(cardIds[k])] ?? 0);
      const owned = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
      spare0[i * c + k] = Math.max(0, owned - 1);
      need0[i * c + k] = owned === 0 ? 1 : 0;
    }
  }

  // Cards are bucketed by group; a swap never crosses buckets.
  const groups = buildGroups(cardIds, options.categoryOf);

  const upperBound = computeUpperBound(spare0, need0, n, c, groups);
  const state = createState(spare0, need0, n, c, groups);
  if (n < 2 || upperBound === 0) return formatResult(state, members, cardIds, upperBound, 0);

  // --- search --------------------------------------------------------------
  const random = makeRandom(options.seed ?? 20260812);
  runGreedy(state, random, 0);
  let best = state.trades.slice();
  let bestScore = scoreState(state);
  let iterations = 0;

  const deadline = now() + timeBudget;
  while (best.length < upperBound && now() < deadline) {
    iterations++;
    // Ruin: pull out a few swaps at random, plus everything one member did.
    const ruinCount = 1 + Math.floor(random() * Math.min(6, Math.max(1, state.trades.length)));
    for (let r = 0; r < ruinCount && state.trades.length; r++) {
      undoTrade(state, Math.floor(random() * state.trades.length));
    }
    // Recreate: greedy again, with enough noise to explore a different order.
    runGreedy(state, random, 0.6 + random());

    const score = scoreState(state);
    if (score >= bestScore) {
      bestScore = score;
      best = state.trades.slice();
    } else {
      restoreState(state, best, spare0, need0);
    }
  }

  if (state.trades.length !== best.length) restoreState(state, best, spare0, need0);
  return formatResult(state, members, cardIds, upperBound, iterations);
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function collectCardIds(members) {
  const ids = new Set();
  for (const m of members) for (const k of Object.keys(m.counts || {})) ids.add(Number(k));
  return [...ids].filter((x) => Number.isInteger(x)).sort((a, b) => a - b);
}

/**
 * Groups the card indices by their game category, as {label, indices[]}.
 * Without a category map everything lands in one group, which means "any card
 * may be swapped against any other".
 */
function buildGroups(cardIds, categoryOf) {
  if (!categoryOf) return [{ label: 'all', indices: cardIds.map((_, k) => k) }];
  const lookup = categoryOf instanceof Map ? (id) => categoryOf.get(id) : (id) => categoryOf[id];
  const byCategory = new Map();
  cardIds.forEach((id, k) => {
    const category = lookup(id) ?? lookup(String(id)) ?? 'unknown';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(k);
  });
  return [...byCategory.entries()].map(([label, indices]) => ({ label, indices }));
}

/**
 * Ceiling on the number of swaps. Both halves of a swap live in the same group,
 * so each group is bounded on its own and the bounds are added up. Within a
 * group we take the tighter of two angles:
 *  - per card: copies that can move ≤ min(spare copies, members missing it)
 *  - per member: swaps ≤ min(their spares in the group, their gaps in it)
 * Each swap moves two cards and involves two members, hence the halving.
 */
function computeUpperBound(spare, need, n, c, groups) {
  let total = 0;
  for (const { indices } of groups) {
    let cardTransfers = 0;
    for (const k of indices) {
      let supply = 0;
      let demand = 0;
      for (let i = 0; i < n; i++) {
        supply += spare[i * c + k];
        demand += need[i * c + k];
      }
      cardTransfers += Math.min(supply, demand);
    }
    let memberTransfers = 0;
    for (let i = 0; i < n; i++) {
      let spares = 0;
      let gaps = 0;
      for (const k of indices) {
        spares += spare[i * c + k];
        gaps += need[i * c + k];
      }
      memberTransfers += Math.min(spares, gaps);
    }
    total += Math.floor(Math.min(cardTransfers, memberTransfers) / 2);
  }
  return total;
}

// --- mutable search state ---------------------------------------------------
// 60 cards fit in two 32-bit words; the masks let us skip hopeless pairs fast.

function createState(spare0, need0, n, c, groups = [{ indices: [...Array(c).keys()] }]) {
  const state = {
    n,
    c,
    spare: Int32Array.from(spare0),
    need: Uint8Array.from(need0),
    spareLo: new Int32Array(n),
    spareHi: new Int32Array(n),
    needLo: new Int32Array(n),
    needHi: new Int32Array(n),
    demand: new Int32Array(c), // members still missing card k
    suppliers: new Int32Array(c), // members still holding a spare of card k
    tradeCount: new Int32Array(n),
    trades: [],
    // One bit mask per group, so a candidate swap can be restricted to it.
    groupLo: new Int32Array(groups.length),
    groupHi: new Int32Array(groups.length),
    groupCount: groups.length,
  };
  groups.forEach(({ indices }, g) => {
    for (const k of indices) setBit(state.groupLo, state.groupHi, g, k);
  });
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < c; k++) {
      if (state.spare[i * c + k] > 0) {
        setBit(state.spareLo, state.spareHi, i, k);
        state.suppliers[k]++;
      }
      if (state.need[i * c + k]) {
        setBit(state.needLo, state.needHi, i, k);
        state.demand[k]++;
      }
    }
  }
  return state;
}

function restoreState(state, trades, spare0, need0) {
  const { n, c } = state;
  state.spare.set(spare0);
  state.need.set(need0);
  state.spareLo.fill(0);
  state.spareHi.fill(0);
  state.needLo.fill(0);
  state.needHi.fill(0);
  state.demand.fill(0);
  state.suppliers.fill(0);
  state.tradeCount.fill(0);
  state.trades.length = 0;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < c; k++) {
      if (state.spare[i * c + k] > 0) {
        setBit(state.spareLo, state.spareHi, i, k);
        state.suppliers[k]++;
      }
      if (state.need[i * c + k]) {
        setBit(state.needLo, state.needHi, i, k);
        state.demand[k]++;
      }
    }
  }
  for (const [i, j, x, y] of trades) applyTrade(state, i, j, x, y);
}

function applyTrade(state, i, j, x, y) {
  transfer(state, i, j, x);
  transfer(state, j, i, y);
  state.tradeCount[i]++;
  state.tradeCount[j]++;
  state.trades.push([i, j, x, y]);
}

function transfer(state, from, to, k) {
  const { c } = state;
  if (--state.spare[from * c + k] === 0) {
    clearBit(state.spareLo, state.spareHi, from, k);
    state.suppliers[k]--;
  }
  state.need[to * c + k] = 0;
  clearBit(state.needLo, state.needHi, to, k);
  state.demand[k]--;
}

function undoTrade(state, index) {
  const [i, j, x, y] = state.trades[index];
  state.trades.splice(index, 1);
  untransfer(state, i, j, x);
  untransfer(state, j, i, y);
  state.tradeCount[i]--;
  state.tradeCount[j]--;
}

function untransfer(state, from, to, k) {
  const { c } = state;
  if (state.spare[from * c + k]++ === 0) {
    setBit(state.spareLo, state.spareHi, from, k);
    state.suppliers[k]++;
  }
  state.need[to * c + k] = 1;
  setBit(state.needLo, state.needHi, to, k);
  state.demand[k]++;
}

/** Runs swaps until none remain feasible. */
function runGreedy(state, random, jitter) {
  const { n, demand, suppliers, tradeCount } = state;
  for (;;) {
    let bestScore = Infinity;
    let bi = -1;
    let bj = -1;
    let bx = -1;
    let by = -1;

    for (let i = 0; i < n; i++) {
      const iLo = state.spareLo[i];
      const iHi = state.spareHi[i];
      if (!iLo && !iHi) continue;
      for (let j = i + 1; j < n; j++) {
        const aLo = iLo & state.needLo[j];
        const aHi = iHi & state.needHi[j];
        if (!aLo && !aHi) continue;
        const bLo = state.spareLo[j] & state.needLo[i];
        const bHi = state.spareHi[j] & state.needHi[i];
        if (!bLo && !bHi) continue;

        // Both halves of the swap have to come out of the same group.
        for (let g = 0; g < state.groupCount; g++) {
          const gLo = state.groupLo[g];
          const gHi = state.groupHi[g];
          const agLo = aLo & gLo;
          const agHi = aHi & gHi;
          if (!agLo && !agHi) continue;
          const bgLo = bLo & gLo;
          const bgHi = bHi & gHi;
          if (!bgLo && !bgHi) continue;

          const x = cheapestCard(agLo, agHi, demand, suppliers);
          const y = cheapestCard(bgLo, bgHi, demand, suppliers);
          let score =
            cardCost(x, demand, suppliers) +
            cardCost(y, demand, suppliers) +
            FAIRNESS_WEIGHT * (tradeCount[i] + tradeCount[j]);
          if (jitter) score += random() * jitter;

          if (score < bestScore) {
            bestScore = score;
            bi = i;
            bj = j;
            bx = x;
            by = y;
          }
        }
      }
    }

    if (bi < 0) return;
    applyTrade(state, bi, bj, bx, by);
  }
}

/** Scarcest card in a mask: fewest other places its supply/demand could go. */
function cheapestCard(lo, hi, demand, suppliers) {
  let bestK = -1;
  let bestCost = Infinity;
  let word = lo;
  let base = 0;
  for (let pass = 0; pass < 2; pass++) {
    let w = word;
    while (w) {
      const bit = w & -w;
      const k = base + (31 - Math.clz32(bit >>> 0));
      const cost = cardCost(k, demand, suppliers);
      if (cost < bestCost) {
        bestCost = cost;
        bestK = k;
      }
      w ^= bit;
    }
    word = hi;
    base = 32;
  }
  return bestK;
}

function cardCost(k, demand, suppliers) {
  // Alternative homes for this spare + alternative sources for this gap.
  return demand[k] + suppliers[k] - 2;
}

function setBit(lo, hi, i, k) {
  if (k < 32) lo[i] |= 1 << k;
  else hi[i] |= 1 << (k - 32);
}

function clearBit(lo, hi, i, k) {
  if (k < 32) lo[i] &= ~(1 << k);
  else hi[i] &= ~(1 << (k - 32));
}

/** Trade count dominates; ties break towards an even spread across members. */
function scoreState(state) {
  let min = Infinity;
  let involved = 0;
  for (const t of state.tradeCount) {
    if (t < min) min = t;
    if (t > 0) involved++;
  }
  return state.trades.length * 10000 + involved * 10 + (min === Infinity ? 0 : min);
}

function formatResult(state, members, cardIds, upperBound, iterations) {
  const { trades, spare, need, n, c } = state;
  const byMember = Object.fromEntries(members.map((m) => [m.id, []]));
  const out = [];

  for (const [i, j, x, y] of trades) {
    const a = members[i];
    const b = members[j];
    const give = cardIds[x];
    const get = cardIds[y];
    out.push({ a: a.id, b: b.id, aName: a.name, bName: b.name, aGives: give, bGives: get });
    byMember[a.id].push({ partner: b.id, partnerName: b.name, give, get });
    byMember[b.id].push({ partner: a.id, partnerName: a.name, give: get, get: give });
  }

  const leftovers = {};
  for (let i = 0; i < n; i++) {
    const unmatchedSpares = [];
    const stillMissing = [];
    for (let k = 0; k < c; k++) {
      if (spare[i * c + k] > 0) unmatchedSpares.push(cardIds[k]);
      if (need[i * c + k]) stillMissing.push(cardIds[k]);
    }
    leftovers[members[i].id] = { unmatchedSpares, stillMissing };
  }

  const membersTrading = new Set(out.flatMap((t) => [t.a, t.b])).size;
  return {
    trades: out,
    byMember,
    leftovers,
    stats: {
      trades: out.length,
      cardsMoved: out.length * 2,
      upperBound,
      optimal: out.length >= upperBound,
      membersTrading,
      iterations,
    },
  };
}
