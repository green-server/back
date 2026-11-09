-- Apply once to a database created before 2026-11-09: mysql green_server_20401 < db/migrate-2026-11-09.sql
-- Safe to run before deploying the new backend; the old one ignores the column.
ALTER TABLE tool_calls
  ADD COLUMN request_id VARCHAR(255) NULL AFTER recommendation_id,
  ADD UNIQUE KEY uq_call_request (consultation_id, request_id);
