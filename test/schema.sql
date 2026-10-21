-- עותק של הסכמה הקיימת במסד yemot-pay (מתוך sqlite_master), לבדיקות מקומיות בלבד.
-- לא מורץ על המסד בענן.
CREATE TABLE zeevi_weiss_customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT,
  main_phone TEXT NOT NULL UNIQUE,
  email TEXT,
  id_number TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE zeevi_weiss_courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  ivr_code TEXT UNIQUE,
  billing_type TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_type IN ('monthly','one_time')),
  price REAL NOT NULL,
  max_phones INTEGER NOT NULL DEFAULT 2,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE zeevi_weiss_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('product','meeting','phone_meeting')),
  name TEXT NOT NULL,
  description TEXT,
  ivr_code TEXT UNIQUE,
  price REAL NOT NULL,
  duration_minutes INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE zeevi_weiss_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES zeevi_weiss_customers(id),
  course_id INTEGER NOT NULL REFERENCES zeevi_weiss_courses(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','paused','cancelled','failed')),
  price REAL NOT NULL,
  card_token TEXT,
  start_date TEXT,
  next_charge_date TEXT,
  end_date TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE zeevi_weiss_subscription_phones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES zeevi_weiss_subscriptions(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot IN (1,2)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (subscription_id, slot),
  UNIQUE (subscription_id, phone)
);
CREATE TABLE zeevi_weiss_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES zeevi_weiss_customers(id),
  product_id INTEGER NOT NULL REFERENCES zeevi_weiss_products(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','scheduled','completed','cancelled','refunded')),
  scheduled_at TEXT,
  contact_phone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE zeevi_weiss_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES zeevi_weiss_customers(id),
  subscription_id INTEGER REFERENCES zeevi_weiss_subscriptions(id),
  order_id INTEGER REFERENCES zeevi_weiss_orders(id),
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
);
CREATE TABLE zeevi_weiss_ivr_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  call_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_zw_ivr_log_phone ON zeevi_weiss_ivr_log(phone, created_at);
CREATE INDEX idx_zw_orders_customer ON zeevi_weiss_orders(customer_id);
CREATE INDEX idx_zw_payments_customer ON zeevi_weiss_payments(customer_id);
CREATE INDEX idx_zw_sub_phones_phone ON zeevi_weiss_subscription_phones(phone);
CREATE INDEX idx_zw_subs_customer ON zeevi_weiss_subscriptions(customer_id);
CREATE INDEX idx_zw_subs_next_charge ON zeevi_weiss_subscriptions(status, next_charge_date);
