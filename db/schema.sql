-- Green Server schema (MySQL 8). Apply with: mysql green_server_20401 < db/schema.sql
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  name          VARCHAR(50)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS servers (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id          BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(100) NOT NULL,
  kind             ENUM('baremetal','home_pc','cloud_vm') NOT NULL,
  power_source     ENUM('measured','estimated') NOT NULL,
  rate_plan        ENUM('home_tiered','cloud_hourly') NOT NULL,
  hourly_krw       DECIMAL(10,2) NULL,                 -- cloud_hourly only
  household_kwh    INT UNSIGNED NOT NULL DEFAULT 0,    -- home_tiered: monthly use excluding this server
  agent_token_hash CHAR(64) NOT NULL UNIQUE,           -- sha256 hex
  last_seen_at     DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_servers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS metrics (
  server_id    BIGINT UNSIGNED NOT NULL,
  ts           DATETIME NOT NULL,
  cpu_pct      DECIMAL(5,2) NOT NULL,
  mem_pct      DECIMAL(5,2) NOT NULL,
  watts        DECIMAL(8,2) NOT NULL,
  is_estimated TINYINT(1) NOT NULL,
  PRIMARY KEY (server_id, ts),
  CONSTRAINT fk_metrics_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS metrics_hourly (
  server_id BIGINT UNSIGNED NOT NULL,
  hour      DATETIME NOT NULL,
  avg_watts DECIMAL(8,2) NOT NULL,
  kwh       DECIMAL(10,4) NOT NULL,
  PRIMARY KEY (server_id, hour),
  CONSTRAINT fk_hourly_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS process_samples (
  server_id BIGINT UNSIGNED NOT NULL,
  ts        DATETIME NOT NULL,
  pid       INT UNSIGNED NOT NULL,
  name      VARCHAR(255) NOT NULL,
  cpu_pct   DECIMAL(6,2) NOT NULL,
  watts     DECIMAL(8,2) NOT NULL,
  PRIMARY KEY (server_id, ts, pid),
  CONSTRAINT fk_samples_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS consultations (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  server_id    BIGINT UNSIGNED NOT NULL,
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  auth_mode    ENUM('subscription','api_key') NOT NULL,
  model        VARCHAR(40) NOT NULL DEFAULT 'claude-sonnet-5-5',
  status       ENUM('requested','running','done','failed') NOT NULL DEFAULT 'requested',
  summary      TEXT NULL,
  server_level ENUM('good','fair','warning','critical') NULL,
  feedback     JSON NULL,
  fixes        JSON NULL,
  CONSTRAINT fk_consult_server FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recommendations (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  server_id       BIGINT UNSIGNED NOT NULL,
  consultation_id BIGINT UNSIGNED NULL,
  source          ENUM('rule','ai') NOT NULL,
  type            VARCHAR(40) NOT NULL,
  detail          TEXT NOT NULL,
  est_saving_krw  INT NOT NULL DEFAULT 0,
  status          ENUM('open','applied','dismissed') NOT NULL DEFAULT 'open',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at      DATETIME NULL,
  CONSTRAINT fk_rec_server  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
  CONSTRAINT fk_rec_consult FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  consultation_id   BIGINT UNSIGNED NOT NULL,
  recommendation_id BIGINT UNSIGNED NULL,
  command           TEXT NOT NULL,
  tier              ENUM('auto','approve','deny') NOT NULL,
  decision          ENUM('auto','pending','approved','denied','blocked') NOT NULL,
  approved_at       DATETIME NULL,
  exit_code         INT NULL,
  undo_command      TEXT NULL,
  undo_of           BIGINT UNSIGNED NULL,
  CONSTRAINT fk_call_consult FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE,
  CONSTRAINT fk_call_rec     FOREIGN KEY (recommendation_id) REFERENCES recommendations(id) ON DELETE SET NULL,
  CONSTRAINT fk_call_undo    FOREIGN KEY (undo_of) REFERENCES tool_calls(id) ON DELETE SET NULL
);
