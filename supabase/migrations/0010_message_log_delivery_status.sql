-- Real delivery/read status for outbound messages, sourced from Meta's own
-- "statuses" webhook callbacks (sent/delivered/read/failed), keyed by the
-- WhatsApp message id ("wamid") Meta returns from the send call. Without this,
-- the dashboard could only ever show "sent" (or our own local send failure),
-- never whether the recipient's phone actually received or opened it - which
-- is what "connected to Meta" concretely means for message status.
alter table message_log add column if not exists wamid text;
alter table message_log add column if not exists status text;

create index if not exists message_log_wamid_idx
  on message_log (wamid) where wamid is not null;
