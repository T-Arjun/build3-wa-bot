-- ─── perks (startup "Perks & credits" directory) ────────────────────────────
-- Manually curated (not synced from the source API). Seeded by
-- scripts/seed_perks.js and editable from the /admin dashboard. Access is
-- external - access_url points at each partner's own signup/redemption page,
-- or the how_to_access text carries an email / multi-step instructions.
create table if not exists perks (
  id             bigserial primary key,
  slug           text unique not null,         -- stable id, used in reply ids: perk:<slug>
  name           text not null,
  objective      text not null,                -- one-line "what it's for" (list row + card)
  categories     text[] not null default '{}', -- taxonomy tags for the category picker
  description    text,                          -- longer blurb (trimmed on the card)
  how_to_access  text not null,                 -- the actionable part: links, emails, steps
  access_url     text,                          -- primary link, if any (null for email-only)
  is_active      boolean not null default true,
  sort_order     integer default 100,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create index if not exists perks_active_idx on perks (is_active);
create index if not exists perks_categories_idx on perks using gin (categories);

drop trigger if exists perks_set_updated_at on perks;
create trigger perks_set_updated_at before update on perks
  for each row execute function set_updated_at();
