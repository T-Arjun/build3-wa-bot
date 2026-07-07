-- Grouped message counts per conversation, used by the admin dashboard's
-- sidebar badge. Querying this view scales with the number of DISTINCT
-- conversations, not the total row count of `message_log` - unlike pulling
-- every wa_id and grouping in JS (which also silently under-counts once the
-- table exceeds whatever row limit that query used).
create or replace view message_log_counts as
  select wa_id, count(*) as message_count
  from message_log
  group by wa_id;
