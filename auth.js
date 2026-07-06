const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

// Without JWT_SECRET set, fall back to a random per-boot secret rather than a
// committed constant: sessions won't survive a restart, but tokens can't be
// forged by anyone reading this file.
const SECRET =
  process.env.JWT_SECRET ||
  (() => {
    console.warn(
      "[auth] JWT_SECRET is not set — using a random secret for this boot only. " +
        "All sessions will be invalidated on restart. Set JWT_SECRET in the environment."
    );
    return crypto.randomBytes(32).toString("hex");
  })();
const TOKEN_EXPIRY = "8h";

// ── Password helpers ──────────────────────────────────────────────────────────

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

// ── JWT helpers ───────────────────────────────────────────────────────────────

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

// ── Middleware: authenticate ──────────────────────────────────────────────────
// Extracts JWT from Authorization header or cookie, verifies it,
// and attaches req.user = { id, username, role }

function authenticate(req, res, next) {
  let token = null;

  // Check Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }

  // Fallback to cookie
  if (!token && req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired, please login again" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }

  // Re-check role and active status from the DB so deactivating or demoting a
  // user takes effect immediately, not when their 8h token expires.
  const { db } = require("./db");
  db.get(`SELECT role, is_active FROM users WHERE id = ?`, [decoded.id], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row || !row.is_active) {
      return res.status(403).json({ error: "Account is deactivated" });
    }
    req.user = { id: decoded.id, username: decoded.username, role: row.role };
    next();
  });
}

// ── Middleware: authorize ─────────────────────────────────────────────────────
// Returns middleware that checks if req.user.role is in the allowed roles list

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Access denied. Insufficient permissions." });
    }
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  authenticate,
  authorize,
};
