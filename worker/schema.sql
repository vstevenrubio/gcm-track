-- date = '' means every day the train runs; otherwise a single service date (YYYYMMDD).
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  sub TEXT NOT NULL,
  train TEXT NOT NULL,
  date TEXT NOT NULL DEFAULT '',
  created INTEGER,
  UNIQUE (endpoint, train, date)
);
CREATE INDEX IF NOT EXISTS watches_date ON watches (date);
-- last track already announced for a watch on a given day (to detect track changes)
CREATE TABLE IF NOT EXISTS sent (watch_id INTEGER NOT NULL, date TEXT NOT NULL, track TEXT NOT NULL, PRIMARY KEY (watch_id, date));
