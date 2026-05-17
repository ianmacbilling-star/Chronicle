-- Chronicle Database Schema
-- Version 3.0

-- Users table (DM/GM accounts)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER,
  edited_at DATETIME,
  edited_by INTEGER
);

-- Campaigns table
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  art_style TEXT DEFAULT 'High fantasy illustration',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER NOT NULL,
  edited_at DATETIME,
  edited_by INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Characters table (belong to a campaign)
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  player_name TEXT,
  cls TEXT,
  description TEXT,
  image TEXT,
  image_portrait TEXT,
  image_fullbody TEXT,
  image_action TEXT,
  image_other TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER NOT NULL,
  edited_at DATETIME,
  edited_by INTEGER,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

-- Sessions table (belong to a campaign)
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  session_date DATE NOT NULL,
  transcript TEXT,
  session_notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER NOT NULL,
  edited_at DATETIME,
  edited_by INTEGER,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

-- Moments table (belong to a session)
CREATE TABLE IF NOT EXISTS moments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT,
  prompt TEXT,
  image TEXT,
  panel_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER NOT NULL,
  edited_at DATETIME,
  edited_by INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
