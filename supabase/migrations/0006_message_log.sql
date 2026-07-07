-- Full-fidelity, append-only message log - independent of `conversations.history`
-- (which is intentionally capped to the last 10 entries for LLM context cost, and
-- only stores flattened text, never the actual rich content sent). This table is
-- the audit trail the admin dashboard reads from: every inbound message/tap and
-- every outbound send (text/image/list/buttons/cta), unbounded, with full payload.
create table if not exists message_log (
  id          bigserial primary key,
  wa_id       text not null,
  direction   text not null check (direction in ('in', 'out')),
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  ok          boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists message_log_wa_id_created_at_idx
  on message_log (wa_id, created_at);

alter table message_log enable row level security;
