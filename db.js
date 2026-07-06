const path = require("path");
const sqlite3 = require("sqlite3").verbose();

// DB_PATH override lets tests run against a throwaway database (":memory:" or a temp file)
const dbPath = process.env.DB_PATH || path.join(__dirname, "data.db");
const db = new sqlite3.Database(dbPath);

function init() {
  db.run("PRAGMA foreign_keys = ON");

  db.serialize(() => {
    // ── Users table (authentication & roles) ──────────────────────────────
    db.run(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'cashier' CHECK(role IN ('admin','manager','cashier')),
        full_name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_login TEXT
      )`
    );

    // ── Products table ────────────────────────────────────────────────────
    db.run(
      `CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        unit TEXT NOT NULL,
        unit_price REAL NOT NULL,
        stock_qty INTEGER NOT NULL,
        barcode TEXT UNIQUE,
        cost_price REAL DEFAULT 0,
        supplier_id INTEGER REFERENCES suppliers(id),
        created_at TEXT NOT NULL,
        updated_at TEXT
      )`
    );

    // ── Sales table ───────────────────────────────────────────────────────
    db.run(
      `CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_no TEXT NOT NULL UNIQUE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        product_name TEXT NOT NULL,
        unit TEXT NOT NULL,
        qty INTEGER NOT NULL,
        unit_price REAL NOT NULL,
        gross_total REAL NOT NULL,
        discount REAL NOT NULL,
        taxable_total REAL NOT NULL,
        gst_percent REAL NOT NULL,
        gst_amount REAL NOT NULL,
        total REAL NOT NULL,
        payment_mode TEXT NOT NULL,
        customer_name TEXT,
        sold_at TEXT NOT NULL
      )`
    );

    // ── Settings table (singleton) ────────────────────────────────────────
    db.run(
      `CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        store_name TEXT NOT NULL,
        store_phone TEXT,
        store_address TEXT,
        gst_percent REAL NOT NULL,
        low_stock_threshold INTEGER NOT NULL
      )`
    );

    db.run(
      `INSERT OR IGNORE INTO settings
        (id, store_name, store_phone, store_address, gst_percent, low_stock_threshold)
        VALUES (1, 'My Grocery Store', '', '', 5, 5)`
    );

    // ── Audit log table ───────────────────────────────────────────────────
    db.run(
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id INTEGER,
        detail TEXT,
        user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL
      )`
    );

    // ── Suppliers table ───────────────────────────────────────────────────
    db.run(
      `CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        contact_person TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        gst_number TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )`
    );

    // ── Purchase Orders table ─────────────────────────────────────────────
    db.run(
      `CREATE TABLE IF NOT EXISTS purchase_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_number TEXT NOT NULL UNIQUE,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        qty INTEGER NOT NULL,
        unit_cost REAL NOT NULL,
        total_cost REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','received','cancelled')),
        ordered_at TEXT NOT NULL,
        received_at TEXT
      )`
    );

    // ── Customers table ───────────────────────────────────────────────────
    db.run(
      `CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT UNIQUE,
        email TEXT,
        address TEXT,
        total_purchases REAL NOT NULL DEFAULT 0,
        visit_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`
    );

    // ── Returns table ─────────────────────────────────────────────────────
    db.run(
      `CREATE TABLE IF NOT EXISTS returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_no TEXT NOT NULL UNIQUE,
        sale_id INTEGER NOT NULL REFERENCES sales(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        qty INTEGER NOT NULL,
        refund_amount REAL NOT NULL,
        reason TEXT NOT NULL,
        processed_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL
      )`
    );

    // ── Expenses table ────────────────────────────────────────────────────
    db.run(
      `CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        description TEXT,
        amount REAL NOT NULL,
        payment_mode TEXT NOT NULL DEFAULT 'Cash',
        expense_date TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL
      )`
    );

    // ── Indexes for performance ───────────────────────────────────────────
    db.run(`CREATE INDEX IF NOT EXISTS idx_sales_product_id ON sales(product_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales(sold_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_returns_sale_id ON returns(sale_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date)`);

    // ── Migration: add columns for existing databases ─────────────────────
    db.run(`ALTER TABLE products ADD COLUMN updated_at TEXT`, function (err) {});
    db.run(`ALTER TABLE products ADD COLUMN barcode TEXT`, function (err) {});
    db.run(`ALTER TABLE products ADD COLUMN cost_price REAL DEFAULT 0`, function (err) {});
    db.run(`ALTER TABLE products ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)`, function (err) {});
    db.run(`ALTER TABLE sales ADD COLUMN customer_id INTEGER REFERENCES customers(id)`, function (err) {});
    db.run(`ALTER TABLE audit_log ADD COLUMN user_id INTEGER REFERENCES users(id)`, function (err) {});
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)`);

    // No seeded default admin: a well-known admin/admin123 account in a public
    // repo is a standing takeover risk. Bootstrap instead via the register
    // endpoint — the first registered user automatically becomes admin.
  });
}

module.exports = { db, init };
