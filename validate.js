function requireString(value, fieldName) {
  var trimmed = (value || "").toString().trim();
  if (!trimmed) {
    throw new ValidationError(fieldName + " is required");
  }
  return trimmed;
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

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

module.exports = { requireString, requireNonNegativeNumber, requirePositiveInt, ValidationError };
