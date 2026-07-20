-- ─── rename sherpas -> mentors (product decision: drop "Sherpa"/"free" branding,
-- call the guide directory "mentors" / "mentor hours" everywhere) ─────────────
-- Table content and columns are unchanged; only the name changes so it matches
-- the renamed domain/*.js layer and bot copy.
alter table if exists sherpas rename to mentors;

alter index if exists sherpas_active_idx rename to mentors_active_idx;
alter index if exists sherpas_areas_idx rename to mentors_areas_idx;

alter trigger sherpas_set_updated_at on mentors rename to mentors_set_updated_at;
