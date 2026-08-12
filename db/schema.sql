-- ClashSwap schema. Safe to re-run.
create extension if not exists pgcrypto;

-- A clan/project. Its id is the unguessable secret that gets shared as a link.
create table if not exists clans (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists members (
  id          uuid primary key default gen_random_uuid(),
  clan_id     uuid not null references clans(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists members_clan_name_key on members (clan_id, lower(btrim(name)));
create index if not exists members_clan_idx on members (clan_id);

-- One row per card a member actually owns. Absent row == owns none.
create table if not exists member_cards (
  member_id   uuid not null references members(id) on delete cascade,
  card_id     smallint not null check (card_id between 1 and 60),
  count       smallint not null default 0 check (count between 0 and 99),
  updated_at  timestamptz not null default now(),
  primary key (member_id, card_id)
);

create index if not exists member_cards_member_idx on member_cards (member_id);

-- The app talks to Postgres directly with the service credentials, which bypass
-- RLS as table owner. Enabling RLS with no policies slams the door on Supabase's
-- public PostgREST endpoint, so an anon key alone can read or write nothing.
alter table clans enable row level security;
alter table members enable row level security;
alter table member_cards enable row level security;

revoke all on clans, members, member_cards from anon, authenticated;
