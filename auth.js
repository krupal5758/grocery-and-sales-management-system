const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Never ship a hardcoded/predictable JWT secret — anyone who knows it can forge
// tokens for any user/role. Require it from the environment in production; in
// development fall back to a random per-process secret (tokens won't survive a
// restart, which is fine locally) and warn loudly.
const SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET environment variable is required in production");
  }
  console.warn(
    "[auth] JWT_SECRET is not set — using a random ephemeral secret. " +
      "Set JWT_SECRET in your environment for stable, secure tokens."
  );
  return crypto.randomBytes(48).toString("hex");
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

  try {
    const decoded = verifyToken(token);
    req.user = { id: decoded.id, username: decoded.username, role: decoded.role };
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired, please login again" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
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
