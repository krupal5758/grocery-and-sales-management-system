function requireString(value, fieldName, maxLength = 200) {
  var trimmed = (value || "").toString().trim();
  if (!trimmed) {
    throw new ValidationError(fieldName + " is required");
  }
  if (trimmed.length > maxLength) {
    throw new ValidationError(fieldName + " must be at most " + maxLength + " characters");
  }
  return trimmed;
}

function optionalString(value, fieldName, maxLength = 200) {
  if (value === undefined || value === null || value === "") return "";
  return requireString(value, fieldName, maxLength);
}

function requireNonNegativeNumber(value, fieldName) {
  var num = Number(value);
  if (Number.isNaN(num) || num < 0) {
    throw new ValidationError(fieldName + " must be a non-negative number");
  }
  return num;
}

function requirePositiveInt(value, fieldName) {
  var num = parseInt(value, 10);
  if (Number.isNaN(num) || num <= 0) {
    throw new ValidationError(fieldName + " must be a positive integer");
  }
  return num;
}

// Pragmatic format check, not full RFC 5322 — just rejects obvious garbage.
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireEmail(value, fieldName) {
  var email = requireString(value, fieldName, 200);
  if (!EMAIL_RE.test(email)) {
    throw new ValidationError(fieldName + " is not a valid email address");
  }
  return email;
}

function optionalEmail(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  return requireEmail(value, fieldName);
}

// Accepts digits with optional +, spaces, dashes, parentheses; 6-15 digits total.
var PHONE_RE = /^\+?[\d\s\-()]{6,20}$/;

function optionalPhone(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  var phone = requireString(value, fieldName, 20);
  var digits = phone.replace(/\D/g, "");
  if (!PHONE_RE.test(phone) || digits.length < 6 || digits.length > 15) {
    throw new ValidationError(fieldName + " is not a valid phone number");
  }
  return phone;
}

function requireOneOf(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throw new ValidationError(fieldName + " must be one of: " + allowed.join(", "));
  }
  return value;
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

module.exports = {
  requireString,
  optionalString,
  requireNonNegativeNumber,
  requirePositiveInt,
  requireEmail,
  optionalEmail,
  optionalPhone,
  requireOneOf,
  ValidationError,
};
