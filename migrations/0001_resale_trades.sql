CREATE TABLE IF NOT EXISTS resale_trades (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  cost_cents INTEGER NOT NULL CHECK(cost_cents > 0),
  proceeds_cents INTEGER CHECK(proceeds_cents >= 0),
  bought_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sold_at TEXT,
  PRIMARY KEY(chat_id,user_id,item_id)
);
