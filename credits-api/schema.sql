CREATE DATABASE IF NOT EXISTS peanut_game;
USE peanut_game;

CREATE TABLE players (
  id            CHAR(36) PRIMARY KEY,
  credits       INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE codes (
  code          VARCHAR(32) PRIMARY KEY,
  amount        INT NOT NULL,
  max_uses      INT NOT NULL DEFAULT 1,          -- 1 = single use
  used_count    INT NOT NULL DEFAULT 0,
  active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE redeemed_codes (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  code          VARCHAR(32) NOT NULL,
  player_id     CHAR(36) NOT NULL,
  amount        INT NOT NULL,
  redeemed_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_player_code (player_id, code),
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (code) REFERENCES codes(code)
);

CREATE TABLE milestones (
  player_id     CHAR(36) NOT NULL,
  value         INT NOT NULL,
  awarded_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, value),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE credit_ledger (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  player_id     CHAR(36) NOT NULL,
  change_amount INT NOT NULL,
  reason        VARCHAR(64) NOT NULL,          -- 'redeem', 'milestone', 'score_bonus', 'use'
  meta          JSON NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

-- Example codes (remove or change in production)
INSERT INTO codes (code, amount, max_uses) VALUES
('SMALL-1234', 1, 1),
('BIG-5678', 3, 1);