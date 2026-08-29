const fs = require('node:fs');
const path = require('node:path');

// Overridable so an offline test can point at a scratch directory instead of
// a real deployment's data/ -- unset, this is unchanged from before.
const DATA_DIR = process.env.TICKETS_DATA_DIR
  ? path.resolve(process.env.TICKETS_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'tickets.json');
const TMP_FILE = `${DB_FILE}.tmp`;
const BAK_FILE = `${DB_FILE}.bak`;

const EMPTY_DB = { guilds: {} };

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_FILE)) {
    writeFileAtomic(DB_FILE, JSON.stringify(EMPTY_DB, null, 2));
  }
}

// Write to a sibling temp file and rename over the target. rename() is atomic on
// NTFS and ext4, so a crash mid-write can never leave truncated JSON behind.
function writeFileAtomic(target, contents) {
  const handle = fs.openSync(TMP_FILE, 'w');
  try {
    fs.writeFileSync(handle, contents);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(TMP_FILE, target);
}

function parseDb(raw, source) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.guilds !== 'object' || parsed.guilds === null) {
    throw new Error(`${source} does not contain a valid { guilds: {} } object`);
  }
  return parsed;
}

function readDb() {
  ensureDb();

  try {
    return parseDb(fs.readFileSync(DB_FILE, 'utf8'), 'tickets.json');
  } catch (error) {
    console.error('tickets.json is unreadable or corrupt:', error.message);
  }

  // Fall back to the last known-good snapshot rather than crashing every
  // interaction for the rest of the process lifetime.
  if (fs.existsSync(BAK_FILE)) {
    try {
      const recovered = parseDb(fs.readFileSync(BAK_FILE, 'utf8'), 'tickets.json.bak');
      console.error('Recovered ticket data from tickets.json.bak.');
      writeFileAtomic(DB_FILE, JSON.stringify(recovered, null, 2));
      return recovered;
    } catch (error) {
      console.error('tickets.json.bak is also unreadable:', error.message);
    }
  }

  // Preserve whatever is on disk for manual inspection before starting fresh.
  const quarantine = `${DB_FILE}.corrupt-${Date.now()}`;
  try {
    fs.copyFileSync(DB_FILE, quarantine);
    console.error(`Quarantined corrupt ticket data at ${quarantine}. Starting from an empty database.`);
  } catch (error) {
    console.error('Failed to quarantine corrupt ticket data:', error.message);
  }

  writeFileAtomic(DB_FILE, JSON.stringify(EMPTY_DB, null, 2));
  return { guilds: {} };
}

function writeDb(db) {
  ensureDb();

  // Keep the previous good copy so readDb() has something to recover from.
  if (fs.existsSync(DB_FILE)) {
    try {
      fs.copyFileSync(DB_FILE, BAK_FILE);
    } catch (error) {
      console.error('Failed to refresh tickets.json.bak:', error.message);
    }
  }

  writeFileAtomic(DB_FILE, JSON.stringify(db, null, 2));
}

function getGuildConfig(guildId) {
  const db = readDb();
  return db.guilds[guildId] || null;
}

function getAllGuildConfigs() {
  const db = readDb();
  return db.guilds || {};
}

function setGuildConfig(guildId, config) {
  const db = readDb();
  db.guilds[guildId] = config;
  writeDb(db);
  return config;
}

// Read-modify-write in one shot. Callers that need to mutate based on current
// state must use this instead of getGuildConfig()+setGuildConfig(), which
// interleaves badly when two interactions land at the same time.
function updateGuildConfig(guildId, mutator) {
  const db = readDb();
  const next = mutator(db.guilds[guildId] || null);
  if (next === null || next === undefined) return null;
  db.guilds[guildId] = next;
  writeDb(db);
  return next;
}

module.exports = {
  DATA_DIR,
  ensureDb,
  getAllGuildConfigs,
  getGuildConfig,
  setGuildConfig,
  updateGuildConfig
};
