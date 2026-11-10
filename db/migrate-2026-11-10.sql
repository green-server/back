-- Apply once to a database created before 2026-11-10: mysql green_server_20401 < db/migrate-2026-11-10.sql
-- Safe to run before deploying the new backend; the old one ignores the columns.
ALTER TABLE servers
  ADD COLUMN latitude  DECIMAL(8,5) NULL AFTER last_seen_at,
  ADD COLUMN longitude DECIMAL(8,5) NULL AFTER latitude,
  ADD COLUMN location  VARCHAR(120) NULL AFTER longitude;
