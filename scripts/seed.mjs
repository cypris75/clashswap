/**
 * Creates a demo clan with randomly dealt collections, so you can look at a
 * realistic board without typing 60 numbers twenty times.
 *
 *   npm run seed                          → 20 members, 35 cards drawn each
 *   npm run seed -- --members 10 --draws 45 --name "Test Clan" --seed 7
 *
 * Cards are drawn *with replacement* from the 60-card set, exactly like the
 * event does, so duplicates fall out naturally.
 */
import { loadEnv } from './load-env.mjs';
import { CARDS } from '../src/lib/cards.mjs';

loadEnv();

const { getPool } = await import('../src/lib/db.mjs');

const NAMES = [
  'Trutz', 'BarbarianKing', 'Nightwitch', 'Ravenclaw', 'Zeus', 'Mira', 'Falko', 'Sunny',
  'IronFist', 'Pandora', 'Kaito', 'Luna', 'DerBaumeister', 'Sparky', 'Nova', 'Rasputin',
  'Yuki', 'Bomberman', 'Freya', 'Attila', 'Selene', 'Grom', 'Vex', 'Nadia', 'Otto',
];

function parseArgs(argv) {
  const args = { members: 20, draws: 35, name: null, seed: 42 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key in args) args[key] = key === 'name' ? value : Number(value);
  }
  return args;
}

/** Deterministic PRNG so `--seed 7` always deals the same hands. */
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
 * Deals `draws` random cards to one member.
 * @returns {Record<number, number>} card id → how many copies
 */
export function dealCards(draws, random = Math.random) {
  const counts = {};
  for (let i = 0; i < draws; i++) {
    const card = CARDS[Math.floor(random() * CARDS.length)];
    counts[card.id] = (counts[card.id] || 0) + 1;
  }
  return counts;
}

const args = parseArgs(process.argv.slice(2));
const random = makeRandom(args.seed);
const clanName = args.name || `Demo Clan ${new Date().toISOString().slice(0, 10)}`;
const pool = getPool();

try {
  const { rows } = await pool.query('insert into clans (name) values ($1) returning id', [clanName]);
  const clanId = rows[0].id;

  const pool_names = [...NAMES].sort(() => random() - 0.5);
  let totalCards = 0;
  let totalSpares = 0;

  for (let i = 0; i < args.members; i++) {
    const name = pool_names[i] || `Member ${i + 1}`;
    const counts = dealCards(args.draws, random);
    const cardIds = Object.keys(counts).map(Number);
    const amounts = cardIds.map((id) => counts[id]);

    const member = await pool.query(
      'insert into members (clan_id, name) values ($1, $2) returning id',
      [clanId, name],
    );
    await pool.query(
      `insert into member_cards (member_id, card_id, count)
       select $1, * from unnest($2::smallint[], $3::smallint[])`,
      [member.rows[0].id, cardIds, amounts],
    );

    totalCards += args.draws;
    totalSpares += amounts.reduce((sum, n) => sum + Math.max(0, n - 1), 0);
    console.log(
      `  ${name.padEnd(16)} ${cardIds.length}/60 different cards, ` +
        `${amounts.reduce((s, n) => s + Math.max(0, n - 1), 0)} spares`,
    );
  }

  console.log(
    `\nSeeded "${clanName}" with ${args.members} members ` +
      `(${totalCards} cards dealt, ${totalSpares} spares).`,
  );
  console.log(`\n  Clan link:  http://localhost:${process.env.PORT || 8888}/c/${clanId}\n`);
} finally {
  await pool.end();
}
