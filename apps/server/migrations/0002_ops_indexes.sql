-- Indexes for the abuse limits (posts per user/day) and the keeper's daily spend cap.
CREATE INDEX IF NOT EXISTS posts_creator_created ON posts(creator, created_at);
CREATE INDEX IF NOT EXISTS posts_created ON posts(created_at);
CREATE INDEX IF NOT EXISTS trades_kind_created ON trades(kind, created_at);
