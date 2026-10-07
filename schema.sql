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

CREATE TABLE IF NOT EXISTS pending_deals (
  item_id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  payload TEXT NOT NULL,
  queued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS pending_deals_brand_idx ON pending_deals(brand, queued_at);

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

CREATE TABLE IF NOT EXISTS special_topics (
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, kind)
);

CREATE TABLE IF NOT EXISTS brand_observations (
  bucket TEXT NOT NULL,
  brand TEXT NOT NULL,
  listings INTEGER NOT NULL DEFAULT 0,
  deals INTEGER NOT NULL DEFAULT 0,
  favourites INTEGER NOT NULL DEFAULT 0,
  median_price REAL NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bucket, brand)
);

CREATE INDEX IF NOT EXISTS brand_observations_date_idx ON brand_observations(observed_at);

CREATE TABLE IF NOT EXISTS user_listings (
  item_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  brand TEXT,
  size TEXT,
  status TEXT,
  favourites INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  inactive_at TEXT,
  last_price REAL
);

CREATE INDEX IF NOT EXISTS user_listings_active_idx ON user_listings(active, first_seen_at);

CREATE TABLE IF NOT EXISTS user_listing_details (
  item_id TEXT PRIMARY KEY,
  category TEXT,
  published_at TEXT,
  publication_source TEXT NOT NULL DEFAULT 'first_seen',
  FOREIGN KEY (item_id) REFERENCES user_listings(item_id)
);

CREATE TABLE IF NOT EXISTS user_listing_snapshots (
  item_id TEXT NOT NULL,
  observed_day TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  favourites INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (item_id, observed_day)
);

CREATE INDEX IF NOT EXISTS user_listing_snapshots_day_idx ON user_listing_snapshots(observed_day);

CREATE TABLE IF NOT EXISTS category_observations (
  bucket TEXT NOT NULL,
  brand TEXT NOT NULL,
  category TEXT NOT NULL,
  listings INTEGER NOT NULL DEFAULT 0,
  deals INTEGER NOT NULL DEFAULT 0,
  favourites INTEGER NOT NULL DEFAULT 0,
  median_price REAL NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bucket, brand, category)
);

CREATE INDEX IF NOT EXISTS category_observations_date_idx ON category_observations(observed_at);

CREATE TABLE IF NOT EXISTS photo_sessions (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '',
  analyses TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, user_id)
);
