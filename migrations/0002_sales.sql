-- Durable inbox and new-eSIM orders. No upstream payloads or request URLs are stored.
CREATE TABLE IF NOT EXISTS new_esim_orders (
 id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
 email TEXT NOT NULL, plan_id TEXT NOT NULL, plan_name TEXT NOT NULL, amount_pkr INTEGER NOT NULL,
 dpay_session_id TEXT, checkout_url TEXT, livemode INTEGER, payment_status TEXT NOT NULL DEFAULT 'pending',
 fulfilment_status TEXT NOT NULL DEFAULT 'not_started', email_status TEXT NOT NULL DEFAULT 'not_started',
 iccid TEXT, lpa TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_inbox (
 event_id TEXT PRIMARY KEY, type TEXT NOT NULL, order_id TEXT, session_id TEXT,
 session_status TEXT, amount INTEGER, currency TEXT, livemode INTEGER, state TEXT NOT NULL DEFAULT 'pending',
 received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_inbox_pending ON payment_inbox(state, received_at);
CREATE INDEX IF NOT EXISTS idx_new_esim_work ON new_esim_orders(fulfilment_status, email_status);
