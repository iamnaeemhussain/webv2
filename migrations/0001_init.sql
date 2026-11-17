-- my Pak-Tel: payment + top-up records, webhook de-duplication, rate limiting.

CREATE TABLE IF NOT EXISTS transactions (
  id                TEXT PRIMARY KEY,            -- our order id (also DPay order_id + Idempotency-Key)
  idempotency_key   TEXT NOT NULL UNIQUE,        -- client-supplied key: one checkout per click
  iccid             TEXT NOT NULL,
  plan_id           TEXT NOT NULL,               -- Yesim plan id (sheet column M)
  plan_name         TEXT NOT NULL,               -- sheet column A at time of purchase
  amount_pkr        INTEGER NOT NULL,            -- sheet column B at time of purchase
  dpay_session_id   TEXT,
  dpay_reference    TEXT,
  checkout_url      TEXT,
  expires_at        TEXT,
  livemode          INTEGER,
  amount_paid_paisa INTEGER,
  -- pending | paid | expired | failed | cancelled | review | error
  payment_status    TEXT NOT NULL DEFAULT 'pending',
  -- not_started | processing | success | failed | review
  topup_status      TEXT NOT NULL DEFAULT 'not_started',
  topup_verified    INTEGER NOT NULL DEFAULT 0,  -- 1 once /sim_info confirmed the new resources
  topup_error       TEXT,
  last_checked_at   INTEGER NOT NULL DEFAULT 0,  -- unix s, throttles DPay re-checks
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  paid_at           TEXT,
  topup_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_tx_iccid ON transactions (iccid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_session ON transactions (dpay_session_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,                  -- DPay-Event-Id: each event handled once
  type        TEXT NOT NULL,
  order_id    TEXT,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  win    INTEGER NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, win)
);
