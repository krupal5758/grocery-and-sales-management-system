const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `grocery-test-${Date.now()}.db`);

let server;
let adminToken;

function api(method, url, { token, body, headers = {} } = {}) {
  return fetch(`${BASE}${url}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_PATH, JWT_SECRET: "test-secret", NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  // Wait for the server to come up
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server did not start");
});

after(() => {
  if (server) server.kill();
  for (const f of [DB_PATH, `${DB_PATH}-journal`]) {
    try { fs.unlinkSync(f); } catch {}
  }
});

test("health check responds", async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true });
});

test("no default admin is seeded; protected routes require auth", async () => {
  const res = await api("POST", "/api/auth/login", {
    body: { username: "admin", password: "admin123" },
  });
  assert.strictEqual(res.status, 401, "default admin/admin123 must not exist");

  const products = await api("GET", "/api/products");
  assert.strictEqual(products.status, 401);
});

test("first registered user is auto-promoted to admin", async () => {
  const res = await api("POST", "/api/auth/register", {
    body: { username: "owner", email: "owner@store.com", password: "secret123", fullName: "Store Owner", role: "cashier" },
  });
  assert.strictEqual(res.status, 201);
  const created = await res.json();
  assert.strictEqual(created.role, "admin", "first user should become admin despite requesting cashier");

  const login = await api("POST", "/api/auth/login", {
    body: { username: "owner", password: "secret123" },
  });
  assert.strictEqual(login.status, 200);
  adminToken = (await login.json()).token;
  assert.ok(adminToken);
});

test("second registration requires an admin token", async () => {
  const anon = await api("POST", "/api/auth/register", {
    body: { username: "evil", email: "evil@x.com", password: "secret123", fullName: "Evil", role: "admin" },
  });
  assert.strictEqual(anon.status, 401);

  const ok = await api("POST", "/api/auth/register", {
    token: adminToken,
    body: { username: "cashier1", email: "c1@store.com", password: "secret123", fullName: "Cashier One", role: "cashier" },
  });
  assert.strictEqual(ok.status, 201);
});

test("register rejects malformed email", async () => {
  const res = await api("POST", "/api/auth/register", {
    token: adminToken,
    body: { username: "bademail", email: "not-an-email", password: "secret123", fullName: "Bad Email" },
  });
  assert.strictEqual(res.status, 400);
});

test("login rejects wrong password", async () => {
  const res = await api("POST", "/api/auth/login", {
    body: { username: "owner", password: "wrong-password" },
  });
  assert.strictEqual(res.status, 401);
});

test("sale computes totals, decrements stock, and formats invoice number", async () => {
  const prodRes = await api("POST", "/api/products", {
    token: adminToken,
    body: { name: "Test Rice", category: "Grains", unit: "kg", unitPrice: 100, stockQty: 50 },
  });
  assert.strictEqual(prodRes.status, 201);
  const product = await prodRes.json();

  // qty 4 @ ₹100, ₹40 discount, 5% GST → gross 400, taxable 360, gst 18, total 378
  const saleRes = await api("POST", "/api/sales", {
    token: adminToken,
    body: { productId: product.id, qty: 4, discount: 40, gstPercent: 5, paymentMode: "UPI" },
  });
  assert.strictEqual(saleRes.status, 201);
  const { sale, product: stock } = await saleRes.json();

  assert.strictEqual(sale.grossTotal, 400);
  assert.strictEqual(sale.taxableTotal, 360);
  assert.strictEqual(sale.gstAmount, 18);
  assert.strictEqual(sale.total, 378);
  assert.match(sale.invoiceNo, /^INV-\d{8}-\d{4}$/);
  assert.strictEqual(stock.stockQty, 46);
});

test("sale rejects unknown payment mode and insufficient stock", async () => {
  const prodRes = await api("POST", "/api/products", {
    token: adminToken,
    body: { name: "Test Oil", category: "Oils", unit: "ltr", unitPrice: 150, stockQty: 2 },
  });
  const product = await prodRes.json();

  const badMode = await api("POST", "/api/sales", {
    token: adminToken,
    body: { productId: product.id, qty: 1, paymentMode: "Bitcoin" },
  });
  assert.strictEqual(badMode.status, 400);

  const tooMany = await api("POST", "/api/sales", {
    token: adminToken,
    body: { productId: product.id, qty: 5, paymentMode: "Cash" },
  });
  assert.strictEqual(tooMany.status, 400);
});

test("concurrent sales never produce duplicate invoice numbers", async () => {
  const prodRes = await api("POST", "/api/products", {
    token: adminToken,
    body: { name: "Test Sugar", category: "Essentials", unit: "kg", unitPrice: 50, stockQty: 500 },
  });
  const product = await prodRes.json();

  const N = 15;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      api("POST", "/api/sales", {
        token: adminToken,
        body: { productId: product.id, qty: 1, paymentMode: "Cash" },
      }).then((r) => r.json())
    )
  );

  const invoiceNos = results.map((r) => r.sale && r.sale.invoiceNo).filter(Boolean);
  assert.strictEqual(invoiceNos.length, N, "all concurrent sales should succeed");
  assert.strictEqual(new Set(invoiceNos).size, N, `duplicate invoice numbers: ${invoiceNos.sort().join(", ")}`);
});

test("return refunds the amount actually paid, not the list price", async () => {
  const prodRes = await api("POST", "/api/products", {
    token: adminToken,
    body: { name: "Test Dal", category: "Pulses", unit: "kg", unitPrice: 100, stockQty: 20 },
  });
  const product = await prodRes.json();

  // qty 4 @ ₹100 with ₹40 discount and 5% GST → total paid 378 → per-unit paid 94.50
  const saleRes = await api("POST", "/api/sales", {
    token: adminToken,
    body: { productId: product.id, qty: 4, discount: 40, gstPercent: 5, paymentMode: "Cash" },
  });
  const { sale } = await saleRes.json();

  const retRes = await api("POST", "/api/returns", {
    token: adminToken,
    body: { saleId: sale.id, qty: 2, reason: "damaged" },
  });
  assert.strictEqual(retRes.status, 201);
  const ret = await retRes.json();

  assert.strictEqual(ret.refundAmount, 189, "refund should be (378 / 4) * 2 = 189, not unit_price 100 * 2 = 200");
  assert.match(ret.returnNo, /^RET-\d{8}-\d{4}$/);

  // Cannot return more than was sold
  const tooMany = await api("POST", "/api/returns", {
    token: adminToken,
    body: { saleId: sale.id, qty: 3, reason: "extra" },
  });
  assert.strictEqual(tooMany.status, 400);
});

test("customer endpoints validate phone and email formats", async () => {
  const badPhone = await api("POST", "/api/customers", {
    token: adminToken,
    body: { name: "Bad Phone", phone: "abc" },
  });
  assert.strictEqual(badPhone.status, 400);

  const badEmail = await api("POST", "/api/customers", {
    token: adminToken,
    body: { name: "Bad Email", email: "nope" },
  });
  assert.strictEqual(badEmail.status, 400);

  const good = await api("POST", "/api/customers", {
    token: adminToken,
    body: { name: "Rahul Sharma", phone: "9988776655", email: "rahul@email.com" },
  });
  assert.strictEqual(good.status, 201);
});

test("admin cannot deactivate their own account", async () => {
  const me = await (await api("GET", "/api/auth/me", { token: adminToken })).json();
  const res = await api("PUT", `/api/users/${me.id}`, {
    token: adminToken,
    body: { isActive: false },
  });
  assert.strictEqual(res.status, 400);
});

test("purchase order receive updates stock and PO numbers are well-formed", async () => {
  const supRes = await api("POST", "/api/suppliers", {
    token: adminToken,
    body: { name: "Test Supplier", phone: "9876543210" },
  });
  assert.strictEqual(supRes.status, 201);
  const supplier = await supRes.json();

  const prodRes = await api("POST", "/api/products", {
    token: adminToken,
    body: { name: "Test Atta", category: "Grains", unit: "kg", unitPrice: 60, stockQty: 5 },
  });
  const product = await prodRes.json();

  const poRes = await api("POST", "/api/purchase-orders", {
    token: adminToken,
    body: { supplierId: supplier.id, productId: product.id, qty: 10, unitCost: 45 },
  });
  assert.strictEqual(poRes.status, 201);
  const po = await poRes.json();
  assert.match(po.poNumber, /^PO-\d{8}-\d{4}$/);
  assert.strictEqual(po.totalCost, 450);

  const recvRes = await api("PUT", `/api/purchase-orders/${po.id}/receive`, { token: adminToken });
  assert.strictEqual(recvRes.status, 200);

  const products = await (await api("GET", "/api/products", { token: adminToken })).json();
  const updated = products.find((p) => p.id === product.id);
  assert.strictEqual(updated.stockQty, 15);
});

// Destructive (wipes all data via import), so it runs last.
test("import restores customers, preserves ids, coerces numbers, and reports accurate counts", async () => {
  const payload = {
    customers: [
      { id: 7, name: "Imported Cust", phone: "9000000007", total_purchases: 400, visit_count: 1, created_at: new Date().toISOString() },
      { id: 8, name: "", phone: "9000000008" }, // skipped: no name
    ],
    products: [
      { id: 3, name: "Imported Tea", category: "Beverages", unit: "kg", unitPrice: "200", stockQty: "10" },
      { name: "", unitPrice: 5, stockQty: 5 },           // skipped: no name
      { name: "Bad Price", unitPrice: -1, stockQty: 5 }, // skipped: negative
    ],
    sales: [
      // numeric strings + a customer_id and product_id that must round-trip
      { invoiceNo: "INV-IMPORT-0001", productId: 3, productName: "Imported Tea", unit: "kg", qty: "2", total: "400", customerId: 7, customerName: "Imported Cust", paymentMode: "UPI" },
      { productName: "No Qty", productId: 3, qty: 0, total: 10 },        // skipped: qty 0
      { invoiceNo: "INV-IMPORT-0002", productId: 999, productName: "Ghost", qty: 1, total: 5 }, // skipped: product 999 not imported
    ],
    settings: { storeName: "Imported Store", gstPercent: 12, lowStockThreshold: 3 },
  };

  const res = await api("POST", "/api/import", {
    token: adminToken,
    headers: { "x-confirm": "yes" },
    body: payload,
  });
  assert.strictEqual(res.status, 200);
  const result = await res.json();
  assert.deepStrictEqual(result.imported, { products: 1, customers: 1, sales: 1 });
  assert.deepStrictEqual(result.skipped, { products: 2, customers: 1, sales: 2 });

  // The customer row itself is restored (with its original id)...
  const customers = await (await api("GET", "/api/customers", { token: adminToken })).json();
  assert.ok(customers.some((c) => c.id === 7 && c.name === "Imported Cust"), "customer 7 should be restored");

  // ...and the sale is linked to it with coerced numeric fields.
  const history = await (await api("GET", "/api/customers/7/history", { token: adminToken })).json();
  const imported = history.find((h) => h.invoiceNo === "INV-IMPORT-0001");
  assert.ok(imported, "imported sale should be linked to customer 7");
  assert.strictEqual(imported.qty, 2, "qty should be coerced to a number");
  assert.strictEqual(imported.total, 400, "total should be coerced to a number");
});
