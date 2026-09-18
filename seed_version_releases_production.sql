-- Campaignia -- seed version_releases for PRODUCTION.
-- v3.0.952, TD-804 batch C. Generated 2026-09-18 from the git history, not by hand.
--
-- RUN THIS ONCE, AGAINST PRODUCTION ONLY.
--
-- The dates: the MERGE on origin/main that carried each version, which is the promote itself.
--
-- WHY BY HAND AND NOT IN CODE: staging and production are separate Postgres services and
-- hold different answers, correctly. An application that seeded both would have to know
-- which environment it was, and that knowledge is the coupling this design exists without.
--
-- ON CONFLICT DO NOTHING is load-bearing. A row written by an actual BOOT is an observed
-- fact; a row in this file is derived from git. Observed always wins, so re-running this
-- is safe and can never move a date the application recorded itself.
--
-- Midday is used as the time of day deliberately: git gives a date, not a moment, and
-- midnight would render as the previous day for anybody reading west of Greenwich.

INSERT INTO version_releases (version, first_seen) VALUES
  ('3.0.782', TIMESTAMP '2026-08-24 12:00:00'),
  ('3.0.784', TIMESTAMP '2026-08-24 12:00:00'),
  ('3.0.787', TIMESTAMP '2026-08-24 12:00:00'),
  ('3.0.791', TIMESTAMP '2026-08-25 12:00:00'),
  ('3.0.799', TIMESTAMP '2026-08-26 12:00:00'),
  ('3.0.802', TIMESTAMP '2026-08-27 12:00:00'),
  ('3.0.803', TIMESTAMP '2026-08-27 12:00:00'),
  ('3.0.809', TIMESTAMP '2026-08-27 12:00:00'),
  ('3.0.811', TIMESTAMP '2026-08-31 12:00:00'),
  ('3.0.812', TIMESTAMP '2026-08-31 12:00:00'),
  ('3.0.815', TIMESTAMP '2026-09-02 12:00:00'),
  ('3.0.816', TIMESTAMP '2026-09-02 12:00:00'),
  ('3.0.819', TIMESTAMP '2026-09-02 12:00:00'),
  ('3.0.822', TIMESTAMP '2026-09-02 12:00:00'),
  ('3.0.825', TIMESTAMP '2026-09-02 12:00:00'),
  ('3.0.828', TIMESTAMP '2026-09-09 12:00:00'),
  ('3.0.833', TIMESTAMP '2026-09-09 12:00:00'),
  ('3.0.834', TIMESTAMP '2026-09-09 12:00:00'),
  ('3.0.835', TIMESTAMP '2026-09-09 12:00:00'),
  ('3.0.836', TIMESTAMP '2026-09-09 12:00:00'),
  ('3.0.838', TIMESTAMP '2026-09-09 12:00:00'),
  ('3.0.845', TIMESTAMP '2026-09-10 12:00:00'),
  ('3.0.847', TIMESTAMP '2026-09-10 12:00:00'),
  ('3.0.848', TIMESTAMP '2026-09-10 12:00:00'),
  ('3.0.850', TIMESTAMP '2026-09-10 12:00:00'),
  ('3.0.859', TIMESTAMP '2026-09-11 12:00:00'),
  ('3.0.863', TIMESTAMP '2026-09-11 12:00:00'),
  ('3.0.865', TIMESTAMP '2026-09-12 12:00:00'),
  ('3.0.866', TIMESTAMP '2026-09-12 12:00:00'),
  ('3.0.868', TIMESTAMP '2026-09-12 12:00:00'),
  ('3.0.875', TIMESTAMP '2026-09-12 12:00:00'),
  ('3.0.876', TIMESTAMP '2026-09-12 12:00:00'),
  ('3.0.877', TIMESTAMP '2026-09-12 12:00:00'),
  ('3.0.879', TIMESTAMP '2026-09-12 12:00:00'),
  ('3.0.880', TIMESTAMP '2026-09-12 12:00:00'),
  ('3.0.884', TIMESTAMP '2026-09-13 12:00:00'),
  ('3.0.889', TIMESTAMP '2026-09-13 12:00:00'),
  ('3.0.891', TIMESTAMP '2026-09-13 12:00:00'),
  ('3.0.912', TIMESTAMP '2026-09-14 12:00:00'),
  ('3.0.913', TIMESTAMP '2026-09-14 12:00:00'),
  ('3.0.914', TIMESTAMP '2026-09-15 12:00:00'),
  ('3.0.929', TIMESTAMP '2026-09-17 12:00:00'),
  ('3.0.939', TIMESTAMP '2026-09-17 12:00:00'),
  ('3.0.940', TIMESTAMP '2026-09-17 12:00:00'),
  ('3.0.945', TIMESTAMP '2026-09-17 12:00:00'),
  ('3.0.946', TIMESTAMP '2026-09-17 12:00:00'),
  ('3.0.947', TIMESTAMP '2026-09-17 12:00:00'),
  ('3.0.948', TIMESTAMP '2026-09-17 12:00:00')
ON CONFLICT (version) DO NOTHING;

-- Check it:
-- SELECT version, first_seen FROM version_releases ORDER BY first_seen, version;
