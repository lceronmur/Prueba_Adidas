/**
 * Domain errors. Each one carries its business code and HTTP status, so
 * upper layers never have to translate between the two. See README.md for
 * the error envelope format.
 */
export class AppError extends Error {
  constructor(code, message, status, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid API key.') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(code, message, details) {
    super(code, message, 403, details);
  }
}

export class NotFoundError extends AppError {
  constructor(code, message, details) {
    super(code, message, 404, details);
  }
}

export class ConflictError extends AppError {
  constructor(code, message, details) {
    super(code, message, 409, details);
  }
}

export class InsufficientStockError extends ConflictError {
  constructor({ storeId, sku, available, requested }) {
    super(
      'INSUFFICIENT_STOCK',
      `Store ${storeId} has ${available} units of ${sku}; ${requested} were requested.`,
      { store_id: storeId, sku, available, requested },
    );
  }
}
