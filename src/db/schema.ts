/** טבלאות לקוח חדש, לפי אותה סכמה של הטבלאות הקיימות. prefix חייב לעבור אימות לפני הקריאה. */
export function tenantTablesSql(prefix: string): string[] {
  const p = prefix;
  return [
    `CREATE TABLE IF NOT EXISTS ${p}customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT,
      main_phone TEXT NOT NULL UNIQUE,
      email TEXT,
      id_number TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      ivr_code TEXT UNIQUE,
      billing_type TEXT NOT NULL DEFAULT 'one_time' CHECK (billing_type IN ('monthly','one_time')),
      price REAL NOT NULL,
      max_phones INTEGER NOT NULL DEFAULT 2,
      is_active INTEGER NOT NULL DEFAULT 1,
      access_days INTEGER,
      on_inactive TEXT NOT NULL DEFAULT 'keep',
      ask_phone INTEGER NOT NULL DEFAULT 1,
      offer_text TEXT,
      success_text TEXT,
      send_email INTEGER NOT NULL DEFAULT 1,
      email_to TEXT,
      email_subject TEXT,
      email_body TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'product' CHECK (type IN ('product','meeting','phone_meeting')),
      name TEXT NOT NULL,
      description TEXT,
      ivr_code TEXT UNIQUE,
      price REAL NOT NULL,
      duration_minutes INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      ask_phone INTEGER NOT NULL DEFAULT 0,
      offer_text TEXT,
      success_text TEXT,
      send_email INTEGER NOT NULL DEFAULT 1,
      email_to TEXT,
      email_subject TEXT,
      email_body TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES ${p}customers(id),
      course_id INTEGER NOT NULL REFERENCES ${p}courses(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','paused','cancelled','failed')),
      price REAL NOT NULL,
      card_token TEXT,
      start_date TEXT,
      next_charge_date TEXT,
      end_date TEXT,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    phonesTableSql(`${p}subscription_phones`, p),
    `CREATE TABLE IF NOT EXISTS ${p}orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES ${p}customers(id),
      product_id INTEGER NOT NULL REFERENCES ${p}products(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','scheduled','completed','cancelled','refunded')),
      scheduled_at TEXT,
      contact_phone TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES ${p}customers(id),
      subscription_id INTEGER REFERENCES ${p}subscriptions(id),
      order_id INTEGER REFERENCES ${p}orders(id),
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'ILS',
      status TEXT NOT NULL CHECK (status IN ('pending','success','failed','refunded')),
      provider TEXT,
      transaction_id TEXT,
      card_last4 TEXT,
      installments INTEGER NOT NULL DEFAULT 1,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}ivr_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      call_id TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${p}ivr_log_phone ON ${p}ivr_log(phone, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${p}orders_customer ON ${p}orders(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${p}payments_customer ON ${p}payments(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${p}sub_phones_phone ON ${p}subscription_phones(phone)`,
    `CREATE INDEX IF NOT EXISTS idx_${p}subs_customer ON ${p}subscriptions(customer_id)`,
  ];
}

/** טבלת הטלפונים של מנוי - כמה טלפונים שמוגדר בקורס (slot מ-1 והלאה). */
export function phonesTableSql(name: string, prefix: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id INTEGER NOT NULL REFERENCES ${prefix}subscriptions(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      slot INTEGER NOT NULL CHECK (slot >= 1),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (subscription_id, slot),
      UNIQUE (subscription_id, phone)
    )`;
}
