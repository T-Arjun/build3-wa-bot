-- ─── sherpas (mentor directory for "Book Sherpa Hours") ──────────────────────
-- Manually curated (not synced from the source API). Seeded by
-- scripts/seed_sherpas.js and editable from the /admin dashboard. Booking is
-- external — booking_url points at each mentor's own calendar tool.
create table if not exists sherpas (
  id                bigserial primary key,
  slug              text unique not null,         -- stable id, used in reply ids: sherpa:<slug>
  name              text not null,
  expertise         text not null,                -- blurb shown on the card / list row
  areas             text[] not null default '{}', -- taxonomy tags for the area picker
  booking_url       text not null,                -- external calendar link (surfaced as-is)
  booking_platform  text,                         -- 'google' | 'calcom' | 'calendly' | 'zcal'
  linkedin_url      text,
  avatar_url        text,                         -- optional; card falls back to initials
  bio               text,                         -- optional longer line for the card
  is_active         boolean not null default true,
  sort_order        integer default 100,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists sherpas_active_idx on sherpas (is_active);
create index if not exists sherpas_areas_idx on sherpas using gin (areas);

drop trigger if exists sherpas_set_updated_at on sherpas;
create trigger sherpas_set_updated_at before update on sherpas
  for each row execute function set_updated_at();
