CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brand_state (
  brand TEXT PRIMARY KEY,
  initialized INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT
);

CREATE TABLE IF NOT EXISTS seen_items (
  item_id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS seen_items_brand_idx ON seen_items(brand);

CREATE TABLE IF NOT EXISTS telegram_groups (
  chat_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  configured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS brand_topics (
  chat_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, brand)
);
