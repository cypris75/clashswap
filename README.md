# ClashSwap

Coordinate Clash of Clans card trades inside a clan. Everyone lists how many
copies they hold of each of the 60 event cards; ClashSwap computes the set of
1-for-1 swaps that fills the most gaps across the whole clan.

- One board per clan, reachable only through a random UUID link. No accounts,
  no passwords.
- Members add themselves and tap in their counts (0 = missing, 2+ = spare).
- The trade plan recalculates after every change and says exactly who should
  hand which card to whom.

## Run it locally

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL
npm run migrate           # creates the tables (safe to re-run)
npm run dev               # http://localhost:8888
```

`npm run dev` serves `public/` and runs the API routes in-process, so the local
app behaves exactly like the deployed one — no Netlify CLI needed.

### Demo data

```bash
npm run seed                                         # 20 members, 35 cards each
npm run seed -- --members 10 --draws 45 --seed 7     # or pick your own numbers
```

Cards are drawn *with replacement* from the 60-card set, exactly like the event
does, so duplicates appear naturally. The script prints a ready-to-open link.

### Tests

```bash
npm test
```

Covers the optimizer (including a brute-force comparison over 300 random clans)
and the full API round trip against the database.

## How the trade plan works

`src/lib/optimizer.mjs`. A member *needs* a card when they own zero; copies
beyond the first are *spares*. Every trade is a straight 1-for-1 swap: A gives B
a spare B is missing while B gives A a spare A is missing. Both cards must come
from the same group — the game does not allow trading an Elixir Troop for a Dark
Elixir Troop — so each group is really its own little market.

Maximising the number of such swaps is a matching problem over shared resources
(each spare can only go to one person, each gap only needs filling once), which
is NP-hard in general. The solver runs a scarcity-first greedy — always execute
the swap whose four consumed resources have the fewest alternative uses — and
then improves it with ruin & recreate: tear out a few swaps at random, rebuild,
keep the result if it is no worse. It also computes a theoretical ceiling, so
the UI can state whether a plan is provably the best possible one. On realistic
clan data (20–50 members) it reaches that ceiling in well under a second.

## Layout

```
public/            static front end (no build step) + card art
src/lib/api.mjs    all API routes, platform-agnostic
src/lib/db.mjs     Postgres pool
src/lib/optimizer.mjs
src/lib/cards.mjs  generated — run `npm run gen:cards` to rebuild
netlify/functions/ Netlify adapter
api/               Vercel adapter (only used if you deploy there)
db/schema.sql
scripts/           dev server, migrate, seed, card generator
```

## API

All routes live under `/api`. The clan UUID acts as the shared secret; member
routes are always scoped to their clan, so a member id from one board cannot be
used against another.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/clans` | Create a board → `{ clan }` |
| `GET` | `/api/clans/:clanId` | Board, all members' counts, and the trade plan |
| `PATCH` | `/api/clans/:clanId` | Rename the clan |
| `POST` | `/api/clans/:clanId/members` | Join (`claimExisting: true` takes over an existing name) |
| `PATCH` | `/api/clans/:clanId/members/:memberId` | Rename a member |
| `DELETE` | `/api/clans/:clanId/members/:memberId` | Remove a member |
| `PUT` | `/api/clans/:clanId/members/:memberId/cards` | Replace a whole collection |
| `PATCH` | `/api/clans/:clanId/members/:memberId/cards` | Set one card's count |

## Deploying

The database connection string is **only** ever read server-side, from the
`DATABASE_URL` environment variable. It is never bundled into the front end.

Use the Supabase **pooler** host, not `db.<ref>.supabase.co` — the direct host
is IPv6-only and serverless functions cannot reach it:

```
postgresql://postgres.<project-ref>:<password>@aws-1-<region>.pooler.supabase.com:6543/postgres
```

### Netlify

1. Push this repo to GitHub.
2. In Netlify: **Add new site → Import an existing project**, pick the repo.
   `netlify.toml` already sets the publish directory and functions directory.
3. **Site configuration → Environment variables**: add `DATABASE_URL`.
4. Deploy. `/api/*` is routed to the function automatically.

Or from your machine:

```bash
npx netlify-cli login
npx netlify-cli init
npx netlify-cli env:set DATABASE_URL "postgresql://..."
npx netlify-cli deploy --build --prod
```

### Vercel

`vercel.json` and `api/index.mjs` are already in place:

```bash
npx vercel login
npx vercel env add DATABASE_URL production
npx vercel --prod
```

## Notes

- Card names, ids and art come from clash.ninja; `npm run gen:cards` regenerates
  `src/lib/cards.mjs` and `public/data/cards.json` from the markup in
  `supbase.md`. Icons are stored locally in `public/cards/` rather than hotlinked.
- Row level security is enabled on all three tables with no policies, so
  Supabase's public REST endpoint cannot read or write anything even if someone
  gets hold of the anon key. The app connects as the table owner and is
  unaffected.
- Card art belongs to Supercell. This is a fan-made helper, not an official app.
