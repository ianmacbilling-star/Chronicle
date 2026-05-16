const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../data/chronicle.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Run schema
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);

    // Migrations — safely add new columns if they don't exist
    try { db.exec('ALTER TABLE characters ADD COLUMN player_name TEXT'); } catch(e) {}
    try { db.exec('ALTER TABLE sessions ADD COLUMN session_notes TEXT'); } catch(e) {}
    try { db.exec('ALTER TABLE users ADD COLUMN api_key TEXT'); } catch(e) {}
  }
  return db;
}

module.exports = { getDb };
