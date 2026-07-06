// Auth + RBAC integration tests. Run with: npm test
// Uses an in-memory SQLite DB (DB_PATH=:memory:) — the real data.db is untouched.
process.env.DB_PATH = ":memory:";
process.env.JWT_SECRET = "test-secret";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../server");

// init() runs CREATE TABLEs asynchronously on require; give sqlite a beat.
before(() => new Promise((r) => setTimeout(r, 300)));

const admin = {
  username: "admin1",
  email: "admin1@test.com",
  password: "secret123",
  fullName: "Admin One",
};

let adminToken = null;
let cashierId = null;
let cashierToken = null;

test("first registered user auto-becomes admin", async () => {
  const res = await request(app).post("/api/auth/register").send(admin);
  assert.equal(res.status, 201);
  assert.equal(res.body.role, "admin");
});

test("login returns a token and user payload", async () => {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: admin.username, password: admin.password });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.role, "admin");
  adminToken = res.body.token;
});

test("login rejects a wrong password", async () => {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: admin.username, password: "wrong-password" });
  assert.equal(res.status, 401);
});

test("second registration requires an admin token", async () => {
  const res = await request(app).post("/api/auth/register").send({
    username: "cashier1",
    email: "cashier1@test.com",
    password: "secret123",
    fullName: "Cashier One",
  });
  assert.equal(res.status, 401);
});

test("admin can register a cashier; requested admin role is honored only via admin", async () => {
  const res = await request(app)
    .post("/api/auth/register")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      username: "cashier1",
      email: "cashier1@test.com",
      password: "secret123",
      fullName: "Cashier One",
      role: "cashier",
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.role, "cashier");
  cashierId = res.body.id;

  const login = await request(app)
    .post("/api/auth/login")
    .send({ username: "cashier1", password: "secret123" });
  cashierToken = login.body.token;
});

test("cashier cannot access admin-only user management", async () => {
  const res = await request(app)
    .get("/api/users")
    .set("Authorization", `Bearer ${cashierToken}`);
  assert.equal(res.status, 403);
});

test("unauthenticated requests are rejected", async () => {
  const res = await request(app).get("/api/auth/me");
  assert.equal(res.status, 401);
});

test("deactivating a user revokes access immediately, not at token expiry", async () => {
  const deactivate = await request(app)
    .put(`/api/users/${cashierId}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ isActive: false });
  assert.equal(deactivate.status, 200);

  const res = await request(app)
    .get("/api/auth/me")
    .set("Authorization", `Bearer ${cashierToken}`); // still a valid, unexpired JWT
  assert.equal(res.status, 403);
});

test("admin cannot demote themselves", async () => {
  const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${adminToken}`);
  const res = await request(app)
    .put(`/api/users/${me.body.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ role: "cashier" });
  assert.equal(res.status, 400);
});
