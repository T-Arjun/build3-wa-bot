-- build3-wa-bot — initial schema
-- System of record for the WhatsApp bot. Founders are mirrored (read-only) from
-- the source platform via the 6-hour sync; the bot reads them for search and
-- cofounder matching. Nothing here is ever written back to the source.

-- ─── extensions ──────────────────────────────────────────────────────────────
create extension if not exists pg_trgm;        -- fuzzy name/text search
-- create extension if not exists vector;       -- enable later for pgvector pre-rank

-- ─── founders ────────────────────────────────────────────────────────────────
-- Superset of the source Founder fields we consume from getListedUsers.
create table if not exists founders (
  id                bigserial primary key,
  source_slug       text unique not null,        -- stable id from the source platform
  origin            text not null default 'synced' check (origin in ('synced', 'whatsapp')),

  name              text not null,
  email             text,
  phone             text,                         -- present only when phonePublic on source
  phone_public      boolean default false,
  wa_id             text,                         -- linked WhatsApp number (when known)

  cohort            integer,
  city              text,
  program           text,

  dharma            text,
  traits            text[] default '{}',
  skills            text[] default '{}',
  sector            text,
  looking_for       text[] default '{}',

  startup_name      text,
  startup_idea      text,
  startup_stage     text,
  quote             text,

  primary_role      text,
  platform_role     text[] default '{}',

  investment_thesis text,
  ticket_size       text,
  portfolio         text[] default '{}',

  avatar_url        text,
  banner_url        text,
  linkedin_url      text,
  linkedin          jsonb default '{}'::jsonb,    -- headline/about/followers/etc.

  is_published      boolean default true,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  synced_at         timestamptz default now(),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists founders_sector_idx        on founders (sector);
create index if not exists founders_city_idx          on founders (lower(city));
create index if not exists founders_cohort_idx        on founders (cohort);
create index if not exists founders_published_idx     on founders (is_published);
create index if not exists founders_wa_id_idx         on founders (wa_id);
create index if not exists founders_skills_gin        on founders using gin (skills);
create index if not exists founders_lookingfor_gin    on founders using gin (looking_for);
create index if not exists founders_name_trgm         on founders using gin (name gin_trgm_ops);

-- ─── matches (cofounder match cache) ─────────────────────────────────────────
-- One row per (requester, filter signature). results holds the scored list.
create table if not exists matches (
  id                bigserial primary key,
  requester_slug    text,                         -- founder the matches are for (nullable for anon criteria-only)
  filter_signature  text not null,                -- hash of the applied filters
  results           jsonb not null default '[]'::jsonb,
  model             text,
  computed_at       timestamptz default now(),
  unique (requester_slug, filter_signature)
);

-- ─── conversations (per-WhatsApp-number state) ───────────────────────────────
create table if not exists conversations (
  wa_id             text primary key,
  founder_slug      text,                         -- resolved identity, if any
  flow              text,                         -- current flow (search/profile/match/...)
  step              text,
  draft             jsonb default '{}'::jsonb,    -- onboarding draft (later phase)
  last_results      jsonb default '[]'::jsonb,    -- for "view 2" / "more" pagination
  last_message_at   timestamptz,                  -- for the 24h window
  updated_at        timestamptz default now()
);

-- ─── sync_runs (audit of each 6-hour pull) ───────────────────────────────────
create table if not exists sync_runs (
  id                bigserial primary key,
  status            text not null default 'running' check (status in ('running','completed','failed')),
  pages             integer default 0,
  fetched           integer default 0,
  upserted          integer default 0,
  errors            jsonb default '[]'::jsonb,
  started_at        timestamptz default now(),
  finished_at       timestamptz
);

-- ─── updated_at trigger ──────────────────────────────────────────────────────
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists founders_set_updated_at on founders;
create trigger founders_set_updated_at before update on founders
  for each row execute function set_updated_at();

drop trigger if exists conversations_set_updated_at on conversations;
create trigger conversations_set_updated_at before update on conversations
  for each row execute function set_updated_at();
