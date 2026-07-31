import crypto from 'node:crypto';
import { AppError } from '../services/errors.js';

/** Short per-request id, used to correlate a response with its server log line. */
export function requestId(req, res, next) {
  req.id = `req_${crypto.randomBytes(4).toString('hex')}`;
  res.set('X-Request-Id', req.id);
  return next();
}

export function notFound(req, _res, next) {
  next(new AppError('ROUTE_NOT_FOUND', `Route not found: ${req.method} ${req.path}`, 404));
}

/**
 * Translates any error into the API's single error envelope.
 *
 * Domain errors keep their business code; anything else degrades to
 * INTERNAL_ERROR without leaking internals, but is logged with the
 * request_id so it can still be traced.
 */
export function createErrorHandler({ logger = console } = {}) {
  return function errorHandler(err, req, res, _next) {
    // Malformed JSON body: thrown by express.json() before it reaches routes.
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({
        error: {
          code: 'MALFORMED_JSON',
          message: 'The request body is not valid JSON.',
          request_id: req.id,
        },
      });
    }

    if (err instanceof AppError) {
      return res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
          request_id: req.id,
        },
      });
    }

    logger.error(`[${req.id}] ${req.method} ${req.originalUrl}`, err);

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        request_id: req.id,
      },
    });
  };
}
