-- A denormalized text blob for fuzzy free-text / skill matching.
-- Populated at sync time (see src/sync/mapFounder.js) by concatenating the
-- searchable fields, mirroring the weighted keys in the source utils/search.js.

alter table founders add column if not exists search_blob text;

create index if not exists founders_search_blob_trgm
  on founders using gin (search_blob gin_trgm_ops);
