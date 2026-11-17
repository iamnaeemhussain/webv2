// Creates the D1 tables on first use (idempotent), so a fresh deployment needs no manual
// migration step. Keep in sync with migrations/0001_init.sql.

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS new_esim_orders (
 id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
 email TEXT NOT NULL, plan_id TEXT NOT NULL, plan_name TEXT NOT NULL, amount_pkr INTEGER NOT NULL,
 dpay_session_id TEXT, checkout_url TEXT, livemode INTEGER, payment_status TEXT NOT NULL DEFAULT 'pending',
 fulfilment_status TEXT NOT NULL DEFAULT 'not_started', email_status TEXT NOT NULL DEFAULT 'not_started',
 iccid TEXT, lpa TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS payment_inbox (
 event_id TEXT PRIMARY KEY, type TEXT NOT NULL, order_id TEXT, session_id TEXT,
 session_status TEXT, amount INTEGER, currency TEXT, livemode INTEGER, state TEXT NOT NULL DEFAULT 'pending',
 received_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_payment_inbox_pending ON payment_inbox(state, received_at)`,
  `CREATE INDEX IF NOT EXISTS idx_new_esim_work ON new_esim_orders(fulfilment_status, email_status)`,

  `CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, iccid TEXT NOT NULL, plan_id TEXT NOT NULL,
    plan_name TEXT NOT NULL, amount_pkr INTEGER NOT NULL, dpay_session_id TEXT, dpay_reference TEXT,
    checkout_url TEXT, expires_at TEXT, livemode INTEGER, amount_paid_paisa INTEGER,
    payment_status TEXT NOT NULL DEFAULT 'pending', topup_status TEXT NOT NULL DEFAULT 'not_started',
    topup_verified INTEGER NOT NULL DEFAULT 0, topup_error TEXT, last_checked_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_at TEXT, topup_at TEXT)`,
  "CREATE INDEX IF NOT EXISTS idx_tx_iccid ON transactions (iccid, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_tx_session ON transactions (dpay_session_id)",
  `CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY, type TEXT NOT NULL, order_id TEXT, received_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT NOT NULL, win INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bucket, win))`,
];

let ready = null;

export function ensureSchema(env) {
  if (!env.DB) return Promise.resolve();
  if (!ready) {
    ready = env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql))).catch((error) => { ready = null; throw error; });
  }
  return ready;
}
