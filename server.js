const express = require("express");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const { db, init } = require("./db");
const { requireString, requireNonNegativeNumber, requirePositiveInt, ValidationError } = require("./validate");
const { hashPassword, verifyPassword, generateToken, authenticate, authorize } = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;

init();

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ── Health ──────────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ── AUTH ROUTES (unprotected) ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/auth/register", (req, res) => {
  try {
    const username = requireString(req.body && req.body.username, "Username");
    const email = requireString(req.body && req.body.email, "Email");
    const password = requireString(req.body && req.body.password, "Password");
    const fullName = requireString(req.body && req.body.fullName, "Full name");
    const role = (req.body && req.body.role) || "cashier";

    if (!["admin", "manager", "cashier"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    // Check if any users exist — first user auto-becomes admin
    db.get(`SELECT COUNT(*) as cnt FROM users`, [], (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });

      const isFirstUser = row.cnt === 0;
      const finalRole = isFirstUser ? "admin" : role;

      // If not first user, require auth token (only admin can register new users)
      if (!isFirstUser) {
        let token = null;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
          token = authHeader.substring(7);
        }
        if (!token && req.cookies && req.cookies.token) {
          token = req.cookies.token;
        }
        if (!token) {
          return res.status(401).json({ error: "Only admins can register new users" });
        }
        try {
          const { verifyToken } = require("./auth");
          const decoded = verifyToken(token);
          if (decoded.role !== "admin") {
            return res.status(403).json({ error: "Only admins can register new users" });
          }
        } catch (e) {
          return res.status(401).json({ error: "Invalid token" });
        }
      }

      const passwordHash = hashPassword(password);
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO users (username, email, password_hash, role, full_name, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        [username, email, passwordHash, finalRole, fullName, now],
        function (err2) {
          if (err2) {
            if (String(err2).includes("UNIQUE")) {
              return res.status(409).json({ error: "Username or email already exists" });
            }
            return res.status(500).json({ error: "DB error" });
          }
          logAudit("register", "user", this.lastID, `Registered user "${username}" as ${finalRole}`, null);
          res.status(201).json({ id: this.lastID, username, email, role: finalRole, fullName });
        }
      );
    });
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const username = requireString(req.body && req.body.username, "Username");
    const password = requireString(req.body && req.body.password, "Password");

    db.get(
      `SELECT id, username, email, password_hash, role, full_name as fullName, is_active as isActive
       FROM users WHERE username = ?`,
      [username],
      (err, user) => {
        if (err) return res.status(500).json({ error: "DB error" });
        if (!user) return res.status(401).json({ error: "Invalid username or password" });
        if (!user.isActive) return res.status(403).json({ error: "Account is deactivated" });

        if (!verifyPassword(password, user.password_hash)) {
          return res.status(401).json({ error: "Invalid username or password" });
        }

        const token = generateToken(user);
        const now = new Date().toISOString();
        db.run(`UPDATE users SET last_login = ? WHERE id = ?`, [now, user.id]);

        logAudit("login", "user", user.id, `User "${username}" logged in`, user.id);

        res.cookie("token", token, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 });
        res.json({
          token,
          user: { id: user.id, username: user.username, email: user.email, role: user.role, fullName: user.fullName }
        });
      }
    );
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/auth/me", authenticate, (req, res) => {
  db.get(
    `SELECT id, username, email, role, full_name as fullName, is_active as isActive, created_at as createdAt, last_login as lastLogin
     FROM users WHERE id = ?`,
    [req.user.id],
    (err, user) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!user) return res.status(404).json({ error: "User not found" });
      res.json(user);
    }
  );
});

// ── User Management (admin only) ────────────────────────────────────────────

app.get("/api/users", authenticate, authorize("admin"), (req, res) => {
  db.all(
    `SELECT id, username, email, role, full_name as fullName, is_active as isActive, created_at as createdAt, last_login as lastLogin
     FROM users ORDER BY created_at DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows);
    }
  );
});

app.put("/api/users/:id", authenticate, authorize("admin"), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const { role, isActive, fullName, email } = req.body || {};

  if (role && !["admin", "manager", "cashier"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }

  // Prevent admin from demoting themselves
  if (id === req.user.id && role && role !== "admin") {
    return res.status(400).json({ error: "Cannot change your own role" });
  }

  db.run(
    `UPDATE users SET
      role = COALESCE(?, role),
      is_active = COALESCE(?, is_active),
      full_name = COALESCE(?, full_name),
      email = COALESCE(?, email)
     WHERE id = ?`,
    [role || null, isActive !== undefined ? (isActive ? 1 : 0) : null, fullName || null, email || null, id],
    function (err) {
      if (err) {
        if (String(err).includes("UNIQUE")) return res.status(409).json({ error: "Email already exists" });
        return res.status(500).json({ error: "DB error" });
      }
      if (this.changes === 0) return res.status(404).json({ error: "User not found" });
      logAudit("update", "user", id, `Updated user #${id}`, req.user.id);
      res.json({ ok: true });
    }
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// ── PRODUCTS (protected) ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/products", authenticate, (req, res) => {
  db.all(
    `SELECT id, name, category, unit, unit_price as unitPrice, stock_qty as stockQty,
            barcode, cost_price as costPrice, supplier_id as supplierId,
            created_at as createdAt, updated_at as updatedAt
     FROM products
     ORDER BY name`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows);
    }
  );
});

app.post("/api/products", authenticate, authorize("admin", "manager"), (req, res) => {
  try {
    const name = requireString(req.body && req.body.name, "Name");
    const category = requireString(req.body && req.body.category, "Category");
    const unit = requireString(req.body && req.body.unit, "Unit");
    const unitPrice = requireNonNegativeNumber(req.body && req.body.unitPrice, "Unit price");
    const stockQty = requireNonNegativeNumber(req.body && req.body.stockQty, "Stock qty");
    const costPrice = requireNonNegativeNumber((req.body && req.body.costPrice) || 0, "Cost price");
    const supplierId = (req.body && req.body.supplierId) || null;
    const barcode = (req.body && req.body.barcode) || generateBarcode();

    const now = new Date().toISOString();
    db.run(
      `INSERT INTO products (name, category, unit, unit_price, stock_qty, cost_price, supplier_id, barcode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, category, unit, unitPrice, stockQty, costPrice, supplierId, barcode, now, now],
      function (err) {
        if (err) {
          if (String(err).includes("UNIQUE")) {
            return res.status(409).json({ error: "Product already exists" });
          }
          return res.status(500).json({ error: "DB error" });
        }
        logAudit("create", "product", this.lastID, `Created "${name}"`, req.user.id);
        res.status(201).json({ id: this.lastID, name, category, unit, unitPrice, stockQty, costPrice, supplierId, barcode, createdAt: now, updatedAt: now });
      }
    );
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

app.put("/api/products/:id", authenticate, authorize("admin", "manager"), (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const name = requireString(req.body && req.body.name, "Name");
    const category = requireString(req.body && req.body.category, "Category");
    const unit = requireString(req.body && req.body.unit, "Unit");
    const unitPrice = requireNonNegativeNumber(req.body && req.body.unitPrice, "Unit price");
    const stockQty = requireNonNegativeNumber(req.body && req.body.stockQty, "Stock qty");
    const costPrice = requireNonNegativeNumber((req.body && req.body.costPrice) || 0, "Cost price");
    const supplierId = (req.body && req.body.supplierId) || null;

    const now = new Date().toISOString();
    db.run(
      `UPDATE products SET name = ?, category = ?, unit = ?, unit_price = ?, stock_qty = ?, cost_price = ?, supplier_id = ?, updated_at = ? WHERE id = ?`,
      [name, category, unit, unitPrice, stockQty, costPrice, supplierId, now, id],
      function (err) {
        if (err) {
          if (String(err).includes("UNIQUE")) return res.status(409).json({ error: "Product name already exists" });
          return res.status(500).json({ error: "DB error" });
        }
        if (this.changes === 0) return res.status(404).json({ error: "Not found" });
        logAudit("update", "product", id, `Updated "${name}"`, req.user.id);
        res.json({ ok: true });
      }
    );
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

app.delete("/api/products/:id", authenticate, authorize("admin", "manager"), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  db.get(`SELECT COUNT(*) as cnt FROM sales WHERE product_id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (row && row.cnt > 0) {
      return res.status(409).json({ error: "Cannot delete product with existing sales records" });
    }
    db.run(`DELETE FROM products WHERE id = ?`, [id], function (err2) {
      if (err2) return res.status(500).json({ error: "DB error" });
      if (this.changes === 0) return res.status(404).json({ error: "Not found" });
      logAudit("delete", "product", id, "Product deleted", req.user.id);
      res.json({ ok: true });
    });
  });
});

app.put("/api/products/:id/stock", authenticate, (req, res) => {
  const id = Number(req.params.id);
  const delta = Number(req.body && req.body.delta);
  if (!id || Number.isNaN(delta)) {
    return res.status(400).json({ error: "Invalid input" });
  }

  db.get(`SELECT id, stock_qty as stockQty FROM products WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row) return res.status(404).json({ error: "Not found" });
    const nextStock = row.stockQty + delta;
    if (nextStock < 0) return res.status(400).json({ error: "Insufficient stock" });

    const now = new Date().toISOString();
    db.run(
      `UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?`,
      [nextStock, now, id],
      function (updateErr) {
        if (updateErr) return res.status(500).json({ error: "DB error" });
        logAudit("restock", "product", id, `Stock changed by ${delta} → ${nextStock}`, req.user.id);
        res.json({ id, stockQty: nextStock });
      }
    );
  });
});

app.get("/api/products/low-stock", authenticate, (req, res) => {
  db.all(
    `SELECT p.id, p.name, p.category, p.unit, p.unit_price as unitPrice, p.stock_qty as stockQty
     FROM products p, settings s
     WHERE s.id = 1 AND p.stock_qty <= s.low_stock_threshold
     ORDER BY p.stock_qty ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows);
    }
  );
});

// Barcode lookup
app.get("/api/products/barcode/:code", authenticate, (req, res) => {
  const code = req.params.code;
  db.get(
    `SELECT id, name, category, unit, unit_price as unitPrice, stock_qty as stockQty, barcode,
            cost_price as costPrice, supplier_id as supplierId
     FROM products WHERE barcode = ?`,
    [code],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(404).json({ error: "Product not found" });
      res.json(row);
    }
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// ── SALES (protected) ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/sales", authenticate, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;

  const from = req.query.from || null;
  const to = req.query.to || null;

  let whereClauses = [];
  let params = [];

  if (from) {
    whereClauses.push("sold_at >= ?");
    params.push(from);
  }
  if (to) {
    whereClauses.push("sold_at <= ?");
    params.push(to + "T23:59:59.999Z");
  }

  const where = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

  db.get(`SELECT COUNT(*) as total FROM sales ${where}`, params, (err, countRow) => {
    if (err) return res.status(500).json({ error: "DB error" });
    const total = countRow ? countRow.total : 0;

    db.all(
      `SELECT id, invoice_no as invoiceNo, product_id as productId, product_name as productName,
              unit, qty, unit_price as unitPrice, gross_total as grossTotal, discount,
              taxable_total as taxableTotal, gst_percent as gstPercent, gst_amount as gstAmount,
              total, payment_mode as paymentMode, customer_name as customerName,
              customer_id as customerId, sold_at as soldAt
       FROM sales
       ${where}
       ORDER BY sold_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
      (err2, rows) => {
        if (err2) return res.status(500).json({ error: "DB error" });
        res.json({
          data: rows,
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize)
        });
      }
    );
  });
});

app.get("/api/sales/summary", authenticate, (req, res) => {
  const from = req.query.from || null;
  const to = req.query.to || null;

  let whereClauses = [];
  let params = [];
  if (from) { whereClauses.push("sold_at >= ?"); params.push(from); }
  if (to) { whereClauses.push("sold_at <= ?"); params.push(to + "T23:59:59.999Z"); }
  const where = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

  db.get(
    `SELECT
       COUNT(*) as orders,
       COALESCE(SUM(qty), 0) as items,
       COALESCE(ROUND(SUM(gross_total), 2), 0) as grossRevenue,
       COALESCE(ROUND(SUM(discount), 2), 0) as discountTotal,
       COALESCE(ROUND(SUM(taxable_total), 2), 0) as taxableRevenue,
       COALESCE(ROUND(SUM(gst_amount), 2), 0) as gstCollected,
       COALESCE(ROUND(SUM(total), 2), 0) as revenue
     FROM sales ${where}`,
    params,
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(row);
    }
  );
});

app.post("/api/sales", authenticate, (req, res) => {
  try {
    const productId = requirePositiveInt(req.body && req.body.productId, "Product");
    const qty = requirePositiveInt(req.body && req.body.qty, "Quantity");
    const safeDiscount = requireNonNegativeNumber((req.body && req.body.discount) || 0, "Discount");
    const safeGst = requireNonNegativeNumber((req.body && req.body.gstPercent) || 0, "GST");
    const paymentMode = (req.body && req.body.paymentMode) || "Cash";
    const customerName = (req.body && req.body.customerName) || "";
    const customerId = (req.body && req.body.customerId) || null;

    db.get(
      `SELECT id, name, unit, unit_price as unitPrice, stock_qty as stockQty, cost_price as costPrice FROM products WHERE id = ?`,
      [productId],
      (err, product) => {
        if (err) return res.status(500).json({ error: "DB error" });
        if (!product) return res.status(404).json({ error: "Product not found" });
        if (product.stockQty < qty) return res.status(400).json({ error: "Insufficient stock" });

        const grossTotal = roundMoney(product.unitPrice * qty);
        const discountApplied = Math.min(safeDiscount, grossTotal);
        const taxableTotal = roundMoney(grossTotal - discountApplied);
        const gstAmount = roundMoney(taxableTotal * safeGst / 100);
        const total = roundMoney(taxableTotal + gstAmount);
        const soldAt = new Date().toISOString();

        generateInvoiceNo((invoiceErr, invoiceNo) => {
          if (invoiceErr) return res.status(500).json({ error: "Failed to generate invoice number" });

          db.run("BEGIN TRANSACTION", (beginErr) => {
            if (beginErr) return res.status(500).json({ error: "DB error" });

            const now = new Date().toISOString();
            db.run(
              `UPDATE products SET stock_qty = stock_qty - ?, updated_at = ? WHERE id = ?`,
              [qty, now, productId],
              (updateErr) => {
                if (updateErr) {
                  return db.run("ROLLBACK", () => res.status(500).json({ error: "DB error" }));
                }

                db.run(
                  `INSERT INTO sales
                   (invoice_no, product_id, product_name, unit, qty, unit_price, gross_total, discount,
                    taxable_total, gst_percent, gst_amount, total, payment_mode, customer_name, customer_id, sold_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [invoiceNo, productId, product.name, product.unit, qty, product.unitPrice,
                   grossTotal, discountApplied, taxableTotal, safeGst, gstAmount, total,
                   paymentMode, customerName, customerId, soldAt],
                  function (insertErr) {
                    if (insertErr) {
                      return db.run("ROLLBACK", () => res.status(500).json({ error: "DB error" }));
                    }

                    const saleId = this.lastID;

                    // Update customer stats if customerId provided
                    const afterSale = () => {
                      db.run("COMMIT", (commitErr) => {
                        if (commitErr) {
                          return db.run("ROLLBACK", () => res.status(500).json({ error: "DB error" }));
                        }

                        logAudit("sale", "sale", saleId, `Invoice ${invoiceNo} — ${product.name} x${qty} = ₹${total}`, req.user.id);

                        // Async: check low stock and send email if configured
                        checkLowStockAlert(productId);

                        res.status(201).json({
                          sale: {
                            id: saleId, invoiceNo, productId, productName: product.name,
                            unit: product.unit, qty, unitPrice: product.unitPrice,
                            grossTotal, discount: discountApplied, taxableTotal,
                            gstPercent: safeGst, gstAmount, total, paymentMode, customerName, customerId, soldAt
                          },
                          product: { id: productId, stockQty: product.stockQty - qty }
                        });
                      });
                    };

                    if (customerId) {
                      db.run(
                        `UPDATE customers SET total_purchases = total_purchases + ?, visit_count = visit_count + 1 WHERE id = ?`,
                        [total, customerId],
                        () => afterSale()
                      );
                    } else {
                      afterSale();
                    }
                  }
                );
              }
            );
          });
        });
      }
    );
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── CUSTOMERS (protected) ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/customers", authenticate, (req, res) => {
  const search = req.query.search || "";
  let query = `SELECT id, name, phone, email, address, total_purchases as totalPurchases,
                      visit_count as visitCount, created_at as createdAt FROM customers`;
  let params = [];

  if (search) {
    query += ` WHERE name LIKE ? OR phone LIKE ?`;
    params.push(`%${search}%`, `%${search}%`);
  }
  query += ` ORDER BY name`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" });
    res.json(rows);
  });
});

app.post("/api/customers", authenticate, (req, res) => {
  try {
    const name = requireString(req.body && req.body.name, "Name");
    const phone = (req.body && req.body.phone) || null;
    const email = (req.body && req.body.email) || null;
    const address = (req.body && req.body.address) || null;
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO customers (name, phone, email, address, total_purchases, visit_count, created_at)
       VALUES (?, ?, ?, ?, 0, 0, ?)`,
      [name, phone, email, address, now],
      function (err) {
        if (err) {
          if (String(err).includes("UNIQUE")) return res.status(409).json({ error: "Phone number already exists" });
          return res.status(500).json({ error: "DB error" });
        }
        logAudit("create", "customer", this.lastID, `Created customer "${name}"`, req.user.id);
        res.status(201).json({ id: this.lastID, name, phone, email, address, totalPurchases: 0, visitCount: 0, createdAt: now });
      }
    );
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

app.put("/api/customers/:id", authenticate, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });
    const name = requireString(req.body && req.body.name, "Name");
    const phone = (req.body && req.body.phone) || null;
    const email = (req.body && req.body.email) || null;
    const address = (req.body && req.body.address) || null;

    db.run(
      `UPDATE customers SET name = ?, phone = ?, email = ?, address = ? WHERE id = ?`,
      [name, phone, email, address, id],
      function (err) {
        if (err) {
          if (String(err).includes("UNIQUE")) return res.status(409).json({ error: "Phone number already exists" });
          return res.status(500).json({ error: "DB error" });
        }
        if (this.changes === 0) return res.status(404).json({ error: "Not found" });
        logAudit("update", "customer", id, `Updated customer "${name}"`, req.user.id);
        res.json({ ok: true });
      }
    );
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

app.get("/api/customers/:id/history", authenticate, (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  db.all(
    `SELECT id, invoice_no as invoiceNo, product_name as productName, qty, total, sold_at as soldAt
     FROM sales WHERE customer_id = ? ORDER BY sold_at DESC LIMIT 50`,
    [id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows);
    }
  );
});

app.get("/api/customers/top", authenticate, (req, res) => {
  db.all(
    `SELECT id, name, phone, total_purchases as totalPurchases, visit_count as visitCount
     FROM customers ORDER BY total_purchases DESC LIMIT 10`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows);
    }
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// ── SUPPLIERS (protected) ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/suppliers", authenticate, (req, res) => {
  db.all(
    `SELECT id, name, contact_person as contactPerson, phone, email, address,
            gst_number as gstNumber, is_active as isActive, created_at as createdAt
     FROM suppliers ORDER BY name`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows);
    }
  );
});

app.post("/api/suppliers", authenticate, authorize("admin", "manager"), (req, res) => {
  try {
    const name = requireString(req.body && req.body.name, "Name");
    const contactPerson = (req.body && req.body.contactPerson) || "";
    const phone = (req.body && req.body.phone) || "";
    const email = (req.body && req.body.email) || "";
    const address = (req.body && req.body.address) || "";
    const gstNumber = (req.body && req.body.gstNumber) || "";
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO suppliers (name, contact_person, phone, email, address, gst_number, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [name, contactPerson, phone, email, address, gstNumber, now],
      function (err) {
        if (err) {
          if (String(err).includes("UNIQUE")) return res.status(409).json({ error: "Supplier already exists" });
          return res.status(500).json({ error: "DB error" });
        }
        logAudit("create", "supplier", this.lastID, `Created supplier "${name}"`, req.user.id);
        res.status(201).json({ id: this.lastID, name, contactPerson, phone, email, address, gstNumber, isActive: 1, createdAt: now });
      }
    );
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

app.put("/api/suppliers/:id", authenticate, authorize("admin", "manager"), (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });
    const name = requireString(req.body && req.body.name, "Name");
    const contactPerson = (req.body && req.body.contactPerson) || "";
    const phone = (req.body && req.body.phone) || "";
    const email = (req.body && req.body.email) || "";
    const address = (req.body && req.body.address) || "";
    const gstNumber = (req.body && req.body.gstNumber) || "";
    const isActive = req.body && req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : 1;

    db.run(
      `UPDATE suppliers SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?, gst_number = ?, is_active = ? WHERE id = ?`,
      [name, contactPerson, phone, email, address, gstNumber, isActive, id],
      function (err) {
        if (err) {
          if (String(err).includes("UNIQUE")) return res.status(409).json({ error: "Supplier name already exists" });
          return res.status(500).json({ error: "DB error" });
        }
        if (this.changes === 0) return res.status(404).json({ error: "Not found" });
        logAudit("update", "supplier", id, `Updated supplier "${name}"`, req.user.id);
        res.json({ ok: true });
      }
    );
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

app.delete("/api/suppliers/:id", authenticate, authorize("admin", "manager"), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  db.run(`UPDATE suppliers SET is_active = 0 WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: "DB error" });
    if (this.changes === 0) return res.status(404).json({ error: "Not found" });
    logAudit("delete", "supplier", id, "Supplier deactivated", req.user.id);
    res.json({ ok: true });
  });
});

// ── Purchase Orders ──────────────────────────────────────────────────────────

app.get("/api/purchase-orders", authenticate, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;

  db.get(`SELECT COUNT(*) as total FROM purchase_orders`, [], (err, countRow) => {
    if (err) return res.status(500).json({ error: "DB error" });
    const total = countRow ? countRow.total : 0;

    db.all(
      `SELECT po.id, po.po_number as poNumber, po.supplier_id as supplierId, s.name as supplierName,
              po.product_id as productId, p.name as productName,
              po.qty, po.unit_cost as unitCost, po.total_cost as totalCost,
              po.status, po.ordered_at as orderedAt, po.received_at as receivedAt
       FROM purchase_orders po
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       LEFT JOIN products p ON po.product_id = p.id
       ORDER BY po.ordered_at DESC
       LIMIT ? OFFSET ?`,
      [pageSize, offset],
      (err2, rows) => {
        if (err2) return res.status(500).json({ error: "DB error" });
        res.json({ data: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
      }
    );
  });
});

app.post("/api/purchase-orders", authenticate, authorize("admin", "manager"), (req, res) => {
  try {
    const supplierId = requirePositiveInt(req.body && req.body.supplierId, "Supplier");
    const productId = requirePositiveInt(req.body && req.body.productId, "Product");
    const qty = requirePositiveInt(req.body && req.body.qty, "Quantity");
    const unitCost = requireNonNegativeNumber(req.body && req.body.unitCost, "Unit cost");
    const totalCost = roundMoney(qty * unitCost);
    const now = new Date().toISOString();

    generatePONumber((err, poNumber) => {
      if (err) return res.status(500).json({ error: "Failed to generate PO number" });

      db.run(
        `INSERT INTO purchase_orders (po_number, supplier_id, product_id, qty, unit_cost, total_cost, status, ordered_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [poNumber, supplierId, productId, qty, unitCost, totalCost, now],
        function (err2) {
          if (err2) return res.status(500).json({ error: "DB error" });
          logAudit("create", "purchase_order", this.lastID, `PO ${poNumber} created`, req.user.id);
          res.status(201).json({ id: this.lastID, poNumber, supplierId, productId, qty, unitCost, totalCost, status: "pending", orderedAt: now });
        }
      );
    });
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

app.put("/api/purchase-orders/:id/receive", authenticate, authorize("admin", "manager"), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  db.get(`SELECT * FROM purchase_orders WHERE id = ?`, [id], (err, po) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!po) return res.status(404).json({ error: "PO not found" });
    if (po.status !== "pending") return res.status(400).json({ error: "PO is already " + po.status });

    const now = new Date().toISOString();
    db.run("BEGIN TRANSACTION", (beginErr) => {
      if (beginErr) return res.status(500).json({ error: "DB error" });

      db.run(
        `UPDATE purchase_orders SET status = 'received', received_at = ? WHERE id = ?`,
        [now, id],
        (err2) => {
          if (err2) return db.run("ROLLBACK", () => res.status(500).json({ error: "DB error" }));

          // Auto-update product stock and cost price
          db.run(
            `UPDATE products SET stock_qty = stock_qty + ?, cost_price = ?, updated_at = ? WHERE id = ?`,
            [po.qty, po.unit_cost, now, po.product_id],
            (err3) => {
              if (err3) return db.run("ROLLBACK", () => res.status(500).json({ error: "DB error" }));

              db.run("COMMIT", (commitErr) => {
                if (commitErr) return db.run("ROLLBACK", () => res.status(500).json({ error: "DB error" }));
                logAudit("receive", "purchase_order", id, `PO #${po.po_number} received — stock +${po.qty}`, req.user.id);
                res.json({ ok: true });
              });
            }
          );
        }
      );
    });
  });
});

app.put("/api/purchase-orders/:id/cancel", authenticate, authorize("admin", "manager"), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  db.get(`SELECT * FROM purchase_orders WHERE id = ?`, [id], (err, po) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!po) return res.status(404).json({ error: "PO not found" });
    if (po.status !== "pending") return res.status(400).json({ error: "PO is already " + po.status });

    db.run(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?`, [id], function (err2) {
      if (err2) return res.status(500).json({ error: "DB error" });
      logAudit("cancel", "purchase_order", id, `PO #${po.po_number} cancelled`, req.user.id);
      res.json({ ok: true });
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ── RETURNS (protected) ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/returns", authenticate, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;

  db.get(`SELECT COUNT(*) as total FROM returns`, [], (err, countRow) => {
    if (err) return res.status(500).json({ error: "DB error" });
    const total = countRow ? countRow.total : 0;

    db.all(
      `SELECT r.id, r.return_no as returnNo, r.sale_id as saleId, r.product_id as productId,
              p.name as productName, r.qty, r.refund_amount as refundAmount,
              r.reason, r.created_at as createdAt
       FROM returns r
       LEFT JOIN products p ON r.product_id = p.id
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [pageSize, offset],
      (err2, rows) => {
        if (err2) return res.status(500).json({ error: "DB error" });
        res.json({ data: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
      }
    );
  });
});

app.post("/api/returns", authenticate, (req, res) => {
  try {
    const saleId = requirePositiveInt(req.body && req.body.saleId, "Sale");
    const qty = requirePositiveInt(req.body && req.body.qty, "Quantity");
    const reason = requireString(req.body && req.body.reason, "Reason");

    db.get(
      `SELECT id, product_id, product_name, qty as saleQty, unit_price, total FROM sales WHERE id = ?`,
      [saleId],
      (err, sale) => {
        if (err) return res.status(500).json({ error: "DB error" });
        if (!sale) return res.status(404).json({ error: "Sale not found" });

        // Check already returned qty
        db.get(
          `SELECT COALESCE(SUM(qty), 0) as returnedQty FROM returns WHERE sale_id = ?`,
          [saleId],
          (err2, retRow) => {
            if (err2) return res.status(500).json({ error: "DB error" });
            const alreadyReturned = retRow ? retRow.returnedQty : 0;
            if (alreadyReturned + qty > sale.saleQty) {
              return res.status(400).json({ error: `Cannot return ${qty} items. Already returned ${alreadyReturned} of ${sale.saleQty}` });
            }

            const refundAmount = roundMoney(sale.unit_price * qty);
            const now = new Date().toISOString();

            generateReturnNo((retErr, returnNo) => {
              if (retErr) return res.status(500).json({ error: "Failed to generate return number" });

              db.run("BEGIN TRANSACTION", (beginErr) => {
                if (beginErr) return res.status(500).json({ error: "DB error" });

                // Restore stock
                db.run(
                  `UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE id = ?`,
                  [qty, now, sale.product_id],
                  (err3) => {
                    if (err3) return db.run("ROLLBACK", () => res.status(500).json({ error: "DB error" }));

                    db.run(
                      `INSERT INTO returns (return_no, sale_id, product_id, qty, refund_amount, reason, processed_by, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                      [returnNo, saleId, sale.product_id, qty, refundAmount, reason, req.user.id, now],
                      function (err4) {
                        if (err4) return db.run("ROLLBACK", () => res.status(500).json({ error: "DB error" }));

                        db.run("COMMIT", (commitErr) => {
                          if (commitErr) return db.run("ROLLBACK", () => res.status(500).json({ error: "DB error" }));
                          logAudit("return", "return", this.lastID, `Return ${returnNo} — ${sale.product_name} x${qty}, refund ₹${refundAmount}`, req.user.id);
                          res.status(201).json({ id: this.lastID, returnNo, saleId, productId: sale.product_id, qty, refundAmount, reason, createdAt: now });
                        });
                      }
                    );
                  }
                );
              });
            });
          }
        );
      }
    );
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── EXPENSES (protected) ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/expenses", authenticate, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  const from = req.query.from || null;
  const to = req.query.to || null;

  let whereClauses = [];
  let params = [];
  if (from) { whereClauses.push("expense_date >= ?"); params.push(from); }
  if (to) { whereClauses.push("expense_date <= ?"); params.push(to); }
  const where = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

  db.get(`SELECT COUNT(*) as total FROM expenses ${where}`, params, (err, countRow) => {
    if (err) return res.status(500).json({ error: "DB error" });
    const total = countRow ? countRow.total : 0;

    db.all(
      `SELECT id, category, description, amount, payment_mode as paymentMode,
              expense_date as expenseDate, created_at as createdAt
       FROM expenses ${where}
       ORDER BY expense_date DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
      (err2, rows) => {
        if (err2) return res.status(500).json({ error: "DB error" });
        res.json({ data: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
      }
    );
  });
});

app.post("/api/expenses", authenticate, authorize("admin", "manager"), (req, res) => {
  try {
    const category = requireString(req.body && req.body.category, "Category");
    const description = (req.body && req.body.description) || "";
    const amount = requireNonNegativeNumber(req.body && req.body.amount, "Amount");
    const paymentMode = (req.body && req.body.paymentMode) || "Cash";
    const expenseDate = (req.body && req.body.expenseDate) || new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();

    if (amount <= 0) return res.status(400).json({ error: "Amount must be greater than 0" });

    db.run(
      `INSERT INTO expenses (category, description, amount, payment_mode, expense_date, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [category, description, amount, paymentMode, expenseDate, req.user.id, now],
      function (err) {
        if (err) return res.status(500).json({ error: "DB error" });
        logAudit("create", "expense", this.lastID, `Expense ₹${amount} — ${category}`, req.user.id);
        res.status(201).json({ id: this.lastID, category, description, amount, paymentMode, expenseDate, createdAt: now });
      }
    );
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

app.delete("/api/expenses/:id", authenticate, authorize("admin"), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  db.run(`DELETE FROM expenses WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: "DB error" });
    if (this.changes === 0) return res.status(404).json({ error: "Not found" });
    logAudit("delete", "expense", id, "Expense deleted", req.user.id);
    res.json({ ok: true });
  });
});

app.get("/api/expenses/summary", authenticate, (req, res) => {
  const from = req.query.from || null;
  const to = req.query.to || null;

  let whereClauses = [];
  let params = [];
  if (from) { whereClauses.push("expense_date >= ?"); params.push(from); }
  if (to) { whereClauses.push("expense_date <= ?"); params.push(to); }
  const where = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

  db.all(
    `SELECT category, ROUND(SUM(amount), 2) as total, COUNT(*) as count
     FROM expenses ${where}
     GROUP BY category ORDER BY total DESC`,
    params,
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows);
    }
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// ── SETTINGS (admin only) ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/settings", authenticate, (req, res) => {
  db.get(
    `SELECT store_name as storeName, store_phone as storePhone, store_address as storeAddress,
            gst_percent as gstPercent, low_stock_threshold as lowStockThreshold
     FROM settings WHERE id = 1`,
    [],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(row);
    }
  );
});

app.put("/api/settings", authenticate, authorize("admin"), (req, res) => {
  const { storeName, storePhone, storeAddress, gstPercent, lowStockThreshold } = req.body || {};
  db.run(
    `UPDATE settings
     SET store_name = ?, store_phone = ?, store_address = ?,
         gst_percent = ?, low_stock_threshold = ?
     WHERE id = 1`,
    [
      storeName || "My Grocery Store",
      storePhone || "",
      storeAddress || "",
      Number(gstPercent || 0),
      Number(lowStockThreshold || 5)
    ],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error" });
      logAudit("update", "settings", 1, "Settings updated", req.user.id);
      res.json({ ok: true });
    }
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// ── REPORTS (protected) ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/reports/daily-revenue", authenticate, (req, res) => {
  db.all(
    `SELECT DATE(sold_at) as day, ROUND(SUM(total), 2) as revenue, COUNT(*) as orders
     FROM sales
     GROUP BY DATE(sold_at)
     ORDER BY day DESC
     LIMIT 30`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows.reverse());
    }
  );
});

app.get("/api/reports/top-products", authenticate, (req, res) => {
  db.all(
    `SELECT product_name as name, SUM(qty) as qty, ROUND(SUM(total), 2) as revenue
     FROM sales
     GROUP BY product_name
     ORDER BY revenue DESC
     LIMIT 10`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows);
    }
  );
});

app.get("/api/reports/profit-loss", authenticate, (req, res) => {
  const from = req.query.from || null;
  const to = req.query.to || null;

  let salesWhere = [];
  let salesParams = [];
  let expWhere = [];
  let expParams = [];

  if (from) {
    salesWhere.push("sold_at >= ?"); salesParams.push(from);
    expWhere.push("expense_date >= ?"); expParams.push(from);
  }
  if (to) {
    salesWhere.push("sold_at <= ?"); salesParams.push(to + "T23:59:59.999Z");
    expWhere.push("expense_date <= ?"); expParams.push(to);
  }

  const sw = salesWhere.length ? "WHERE " + salesWhere.join(" AND ") : "";
  const ew = expWhere.length ? "WHERE " + expWhere.join(" AND ") : "";

  db.get(
    `SELECT COALESCE(ROUND(SUM(total), 2), 0) as revenue,
            COALESCE(ROUND(SUM(qty * unit_price), 2), 0) as grossRevenue
     FROM sales ${sw}`,
    salesParams,
    (err, salesRow) => {
      if (err) return res.status(500).json({ error: "DB error" });

      // Calculate COGS using cost_price from products
      db.get(
        `SELECT COALESCE(ROUND(SUM(s.qty * COALESCE(p.cost_price, 0)), 2), 0) as cogs
         FROM sales s LEFT JOIN products p ON s.product_id = p.id ${sw ? sw.replace("sold_at", "s.sold_at") : ""}`,
        salesParams,
        (err2, cogsRow) => {
          if (err2) return res.status(500).json({ error: "DB error" });

          db.get(
            `SELECT COALESCE(ROUND(SUM(amount), 2), 0) as totalExpenses FROM expenses ${ew}`,
            expParams,
            (err3, expRow) => {
              if (err3) return res.status(500).json({ error: "DB error" });

              const revenue = salesRow ? salesRow.revenue : 0;
              const cogs = cogsRow ? cogsRow.cogs : 0;
              const expenses = expRow ? expRow.totalExpenses : 0;
              const grossProfit = roundMoney(revenue - cogs);
              const netProfit = roundMoney(grossProfit - expenses);

              res.json({ revenue, cogs, grossProfit, expenses, netProfit });
            }
          );
        }
      );
    }
  );
});

app.get("/api/reports/monthly-revenue", authenticate, (req, res) => {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();

  db.get(
    `SELECT COALESCE(ROUND(SUM(total), 2), 0) as revenue, COUNT(*) as orders
     FROM sales WHERE sold_at >= ?`,
    [firstOfMonth],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(row);
    }
  );
});

// ── Audit Log ─────────────────────────────────────────────────────────────────

app.get("/api/audit", authenticate, authorize("admin", "manager"), (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const offset = (page - 1) * pageSize;

  db.get(`SELECT COUNT(*) as total FROM audit_log`, [], (err, countRow) => {
    if (err) return res.status(500).json({ error: "DB error" });
    const total = countRow ? countRow.total : 0;

    db.all(
      `SELECT a.id, a.action, a.entity, a.entity_id as entityId, a.detail,
              a.user_id as userId, u.username, a.created_at as createdAt
       FROM audit_log a
       LEFT JOIN users u ON a.user_id = u.id
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`,
      [pageSize, offset],
      (err2, rows) => {
        if (err2) return res.status(500).json({ error: "DB error" });
        res.json({ data: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
      }
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ── DATA MANAGEMENT (admin only) ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function requireConfirmHeader(req, res) {
  if (req.headers["x-confirm"] !== "yes") {
    res.status(400).json({ error: "This operation requires the x-confirm: yes header" });
    return false;
  }
  return true;
}

app.post("/api/seed", authenticate, authorize("admin"), (req, res) => {
  if (!requireConfirmHeader(req, res)) return;

  const now = new Date().toISOString();
  const tag = invoiceDateTag(new Date());

  db.serialize(() => {
    db.run("DELETE FROM returns");
    db.run("DELETE FROM sales");
    db.run("DELETE FROM purchase_orders");
    db.run("DELETE FROM expenses");
    db.run("DELETE FROM products");
    db.run("DELETE FROM customers");
    db.run("DELETE FROM suppliers");
    db.run(
      `UPDATE settings SET store_name = 'My Grocery Store', store_phone = '', store_address = '',
        gst_percent = 5, low_stock_threshold = 5 WHERE id = 1`
    );

    // Sample suppliers
    db.run(
      `INSERT INTO suppliers (name, contact_person, phone, email, address, gst_number, is_active, created_at) VALUES
       ('Agro Fresh Distributors', 'Ramesh Kumar', '9876543210', 'ramesh@agrofresh.com', 'Grain Market, Delhi', '07AAACG1234A1Z5', 1, ?),
       ('Premium Oils Pvt Ltd', 'Suresh Patel', '9876543211', 'suresh@premiumoils.com', 'Industrial Area, Mumbai', '27AABCP5678B1Z9', 1, ?)`,
      [now, now]
    );

    // Sample products with cost_price and supplier
    db.run(
      `INSERT INTO products (name, category, unit, unit_price, cost_price, stock_qty, supplier_id, barcode, created_at, updated_at) VALUES
       ('Basmati Rice', 'Grains', 'kg', 120, 85, 42, 1, '8901234560013', ?, ?),
       ('Sunflower Oil', 'Oils', 'ltr', 165, 120, 18, 2, '8901234560020', ?, ?),
       ('Toor Dal', 'Pulses', 'kg', 145, 100, 9, 1, '8901234560037', ?, ?),
       ('Sugar', 'Essentials', 'kg', 48, 35, 24, 1, '8901234560044', ?, ?)`,
      [now, now, now, now, now, now, now, now]
    );

    // Sample customers
    db.run(
      `INSERT INTO customers (name, phone, email, address, total_purchases, visit_count, created_at) VALUES
       ('Rahul Sharma', '9988776655', 'rahul@email.com', '12 MG Road, Bangalore', 367.5, 1, ?),
       ('Priya Singh', '8877665544', 'priya@email.com', '45 Park Street, Kolkata', 0, 0, ?)`,
      [now, now]
    );

    db.run(
      `INSERT INTO sales
       (invoice_no, product_id, product_name, unit, qty, unit_price, gross_total, discount,
        taxable_total, gst_percent, gst_amount, total, payment_mode, customer_name, customer_id, sold_at)
       VALUES (?, 1, 'Basmati Rice', 'kg', 3, 120, 360, 10, 350, 5, 17.5, 367.5, 'UPI', 'Rahul Sharma', 1, ?),
              (?, 3, 'Toor Dal', 'kg', 2, 145, 290, 0, 290, 5, 14.5, 304.5, 'Cash', '', NULL, ?)`,
      [`INV-${tag}-0001`, now, `INV-${tag}-0002`, now]
    );
  });

  logAudit("seed", "system", null, "Sample data loaded", req.user.id);
  res.json({ ok: true });
});

app.get("/api/export", authenticate, authorize("admin"), (req, res) => {
  const payload = { exportedAt: new Date().toISOString(), products: [], sales: [], customers: [], suppliers: [], expenses: [], settings: {} };

  db.serialize(() => {
    db.all(
      `SELECT id, name, category, unit, unit_price as unitPrice, cost_price as costPrice,
              stock_qty as stockQty, barcode, supplier_id as supplierId, created_at as createdAt
       FROM products ORDER BY id`,
      [],
      (err, products) => {
        if (err) return res.status(500).json({ error: "DB error" });
        payload.products = products;
        db.all(
          `SELECT id, invoice_no as invoiceNo, product_id as productId, product_name as productName,
                  unit, qty, unit_price as unitPrice, gross_total as grossTotal, discount,
                  taxable_total as taxableTotal, gst_percent as gstPercent, gst_amount as gstAmount,
                  total, payment_mode as paymentMode, customer_name as customerName,
                  customer_id as customerId, sold_at as soldAt
           FROM sales ORDER BY id`,
          [],
          (err2, sales) => {
            if (err2) return res.status(500).json({ error: "DB error" });
            payload.sales = sales;
            db.all(`SELECT * FROM customers ORDER BY id`, [], (err3, customers) => {
              if (err3) return res.status(500).json({ error: "DB error" });
              payload.customers = customers;
              db.all(`SELECT * FROM suppliers ORDER BY id`, [], (err4, suppliers) => {
                if (err4) return res.status(500).json({ error: "DB error" });
                payload.suppliers = suppliers;
                db.all(`SELECT * FROM expenses ORDER BY id`, [], (err5, expenses) => {
                  if (err5) return res.status(500).json({ error: "DB error" });
                  payload.expenses = expenses;
                  db.get(
                    `SELECT store_name as storeName, store_phone as storePhone, store_address as storeAddress,
                            gst_percent as gstPercent, low_stock_threshold as lowStockThreshold
                     FROM settings WHERE id = 1`,
                    [],
                    (err6, settings) => {
                      if (err6) return res.status(500).json({ error: "DB error" });
                      payload.settings = settings;
                      res.json(payload);
                    }
                  );
                });
              });
            });
          }
        );
      }
    );
  });
});

app.post("/api/import", authenticate, authorize("admin"), (req, res) => {
  if (!requireConfirmHeader(req, res)) return;

  const payload = req.body || {};
  const products = Array.isArray(payload.products) ? payload.products : [];
  const sales = Array.isArray(payload.sales) ? payload.sales : [];
  const settings = payload.settings || {};

  db.serialize(() => {
    db.run("DELETE FROM returns");
    db.run("DELETE FROM sales");
    db.run("DELETE FROM purchase_orders");
    db.run("DELETE FROM expenses");
    db.run("DELETE FROM products");
    db.run("DELETE FROM customers");
    db.run("DELETE FROM suppliers");

    const stmt = db.prepare(
      `INSERT INTO products (name, category, unit, unit_price, stock_qty, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    products.forEach((p) => {
      if (!p || !p.name) return;
      stmt.run(p.name, p.category || "General", p.unit || "pcs",
               p.unitPrice || 0, p.stockQty || 0,
               p.createdAt || new Date().toISOString(),
               p.createdAt || new Date().toISOString());
    });
    stmt.finalize();

    const salesStmt = db.prepare(
      `INSERT INTO sales
       (invoice_no, product_id, product_name, unit, qty, unit_price, gross_total, discount,
        taxable_total, gst_percent, gst_amount, total, payment_mode, customer_name, sold_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    sales.forEach((s, idx) => {
      if (!s || !s.productName || !s.qty) return;
      salesStmt.run(
        s.invoiceNo || `INV-${invoiceDateTag(s.soldAt || new Date())}-${String(idx + 1).padStart(4, "0")}`,
        s.productId || 0, s.productName, s.unit || "pcs", s.qty || 0,
        s.unitPrice || 0, s.grossTotal || 0, s.discount || 0,
        s.taxableTotal || 0, s.gstPercent || 0, s.gstAmount || 0,
        s.total || 0, s.paymentMode || "Cash", s.customerName || "",
        s.soldAt || new Date().toISOString()
      );
    });
    salesStmt.finalize();

    db.run(
      `UPDATE settings SET store_name = ?, store_phone = ?, store_address = ?,
       gst_percent = ?, low_stock_threshold = ? WHERE id = 1`,
      [
        settings.storeName || "My Grocery Store", settings.storePhone || "",
        settings.storeAddress || "", Number(settings.gstPercent || 0),
        Number(settings.lowStockThreshold || 5)
      ]
    );
  });

  logAudit("import", "system", null, `Imported ${products.length} products, ${sales.length} sales`, req.user.id);
  res.json({ ok: true });
});

app.delete("/api/clear", authenticate, authorize("admin"), (req, res) => {
  if (!requireConfirmHeader(req, res)) return;

  db.serialize(() => {
    db.run("DELETE FROM returns");
    db.run("DELETE FROM sales");
    db.run("DELETE FROM purchase_orders");
    db.run("DELETE FROM expenses");
    db.run("DELETE FROM products");
    db.run("DELETE FROM customers");
    db.run("DELETE FROM suppliers");
    db.run(
      `UPDATE settings SET store_name = 'My Grocery Store', store_phone = '', store_address = '',
       gst_percent = 5, low_stock_threshold = 5 WHERE id = 1`
    );
  });

  logAudit("clear", "system", null, "All data cleared", req.user.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ── BACKUP (admin only) ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const BACKUP_DIR = path.join(__dirname, "backups");

app.get("/api/backups", authenticate, authorize("admin"), (req, res) => {
  if (!fs.existsSync(BACKUP_DIR)) return res.json([]);
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith(".json"))
    .sort()
    .reverse()
    .map(f => ({
      filename: f,
      size: fs.statSync(path.join(BACKUP_DIR, f)).size,
      created: fs.statSync(path.join(BACKUP_DIR, f)).mtime.toISOString()
    }));
  res.json(files);
});

app.post("/api/backups", authenticate, authorize("admin"), (req, res) => {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // Build payload same as export
  const payload = { exportedAt: new Date().toISOString(), products: [], sales: [], customers: [], suppliers: [], expenses: [], settings: {} };

  db.all(`SELECT * FROM products ORDER BY id`, [], (err, products) => {
    if (err) return res.status(500).json({ error: "DB error" });
    payload.products = products;
    db.all(`SELECT * FROM sales ORDER BY id`, [], (err2, sales) => {
      if (err2) return res.status(500).json({ error: "DB error" });
      payload.sales = sales;
      db.all(`SELECT * FROM customers ORDER BY id`, [], (err3, customers) => {
        if (err3) return res.status(500).json({ error: "DB error" });
        payload.customers = customers;
        db.all(`SELECT * FROM suppliers ORDER BY id`, [], (err4, suppliers) => {
          if (err4) return res.status(500).json({ error: "DB error" });
          payload.suppliers = suppliers;
          db.all(`SELECT * FROM expenses ORDER BY id`, [], (err5, expenses) => {
            if (err5) return res.status(500).json({ error: "DB error" });
            payload.expenses = expenses;
            db.get(`SELECT * FROM settings WHERE id = 1`, [], (err6, settings) => {
              if (err6) return res.status(500).json({ error: "DB error" });
              payload.settings = settings;

              const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
              const filename = `backup-${timestamp}.json`;
              fs.writeFileSync(path.join(BACKUP_DIR, filename), JSON.stringify(payload, null, 2));

              // Keep only last 7 backups
              const allBackups = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".json")).sort();
              while (allBackups.length > 7) {
                const oldest = allBackups.shift();
                fs.unlinkSync(path.join(BACKUP_DIR, oldest));
              }

              logAudit("backup", "system", null, `Backup created: ${filename}`, req.user.id);
              res.status(201).json({ filename, size: fs.statSync(path.join(BACKUP_DIR, filename)).size });
            });
          });
        });
      });
    });
  });
});

app.get("/api/backups/:filename", authenticate, authorize("admin"), (req, res) => {
  const filename = req.params.filename;
  // Prevent path traversal
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const filePath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Backup not found" });
  res.download(filePath);
});

// ══════════════════════════════════════════════════════════════════════════════
// ── EMAIL TEST (admin only) ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/settings/test-email", authenticate, authorize("admin"), (req, res) => {
  try {
    const mailer = require("./mailer");
    mailer.sendTestEmail((err, info) => {
      if (err) return res.status(500).json({ error: "Email failed: " + err.message });
      res.json({ ok: true, message: "Test email sent successfully" });
    });
  } catch (e) {
    res.json({ ok: false, message: "Email module not configured. Set SMTP environment variables." });
  }
});

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// ── HELPERS ──────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function generateInvoiceNo(callback) {
  const tag = invoiceDateTag(new Date());
  db.get(
    `SELECT COUNT(*) + 1 as next FROM sales WHERE invoice_no LIKE ?`,
    [`INV-${tag}-%`],
    (err, row) => {
      if (err) return callback(err);
      const counter = String(row ? row.next : 1).padStart(4, "0");
      callback(null, `INV-${tag}-${counter}`);
    }
  );
}

function generatePONumber(callback) {
  const tag = invoiceDateTag(new Date());
  db.get(
    `SELECT COUNT(*) + 1 as next FROM purchase_orders WHERE po_number LIKE ?`,
    [`PO-${tag}-%`],
    (err, row) => {
      if (err) return callback(err);
      const counter = String(row ? row.next : 1).padStart(4, "0");
      callback(null, `PO-${tag}-${counter}`);
    }
  );
}

function generateReturnNo(callback) {
  const tag = invoiceDateTag(new Date());
  db.get(
    `SELECT COUNT(*) + 1 as next FROM returns WHERE return_no LIKE ?`,
    [`RET-${tag}-%`],
    (err, row) => {
      if (err) return callback(err);
      const counter = String(row ? row.next : 1).padStart(4, "0");
      callback(null, `RET-${tag}-${counter}`);
    }
  );
}

function invoiceDateTag(dateValue) {
  const d = new Date(dateValue);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function generateBarcode() {
  // Generate a random EAN-13 compatible barcode
  let code = "890"; // India country prefix
  for (let i = 0; i < 9; i++) {
    code += Math.floor(Math.random() * 10);
  }
  // Calculate check digit
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(code[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return code + checkDigit;
}

function logAudit(action, entity, entityId, detail, userId) {
  db.run(
    `INSERT INTO audit_log (action, entity, entity_id, detail, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [action, entity, entityId, detail, userId || null, new Date().toISOString()],
    (err) => { if (err) console.error("[AUDIT] Failed to log:", err.message); }
  );
}

function checkLowStockAlert(productId) {
  db.get(
    `SELECT p.name, p.stock_qty as stockQty, s.low_stock_threshold as threshold
     FROM products p, settings s WHERE p.id = ? AND s.id = 1`,
    [productId],
    (err, row) => {
      if (err || !row) return;
      if (row.stockQty <= row.threshold) {
        try {
          const mailer = require("./mailer");
          mailer.sendLowStockAlert([{ name: row.name, stockQty: row.stockQty, threshold: row.threshold }]);
        } catch (e) {
          // Mailer not configured, ignore
        }
      }
    }
  );
}
