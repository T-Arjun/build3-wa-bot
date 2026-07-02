-- Native state field for founders.
-- The source API now returns a normalized `state` (92% coverage on live data);
-- for the ~8% legacy rows with a null state we backfill from city at sync time
-- (see src/sync/mapFounder.js -> stateForCity). Search filters regions/states on
-- this column instead of expanding a state into dozens of city-substring guesses.
alter table founders add column if not exists state text;
create index if not exists founders_state_idx on founders (lower(state));
