-- Short-term conversational memory: the last N turns are replayed into the
-- LLM each message so the bot remembers what it just asked / was told.
-- Without this the engine was stateless per message and looped on clarifying
-- questions.

alter table conversations
  add column if not exists history jsonb not null default '[]'::jsonb;
