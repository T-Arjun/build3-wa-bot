-- Per-conversation summary (count + last activity) sourced purely from
-- message_log, the append-only audit trail. Needed because `conversations`
-- (which the admin sidebar used to list from exclusively) can lose a row
-- entirely - e.g. a table reset/clear - while message_log survives untouched.
-- Without this, a founder whose `conversations` row disappeared becomes
-- invisible in the dashboard even though their full history is still on
-- record - discovered live when real founder conversations from before a
-- conversations-table reset turned out to still exist in message_log but
-- nowhere in the sidebar.
create or replace view message_log_summary as
  select wa_id, count(*) as message_count, max(created_at) as last_message_at
  from message_log
  group by wa_id;
