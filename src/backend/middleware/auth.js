import { ForbiddenError, UnauthorizedError } from '../services/errors.js';

/**
 * API key authentication.
 *
 * Two credential types:
 *   store  reports movements for itself, and reads
 *   admin  reads everything and configures thresholds
 *
 * For the demo, keys travel and compare in plain text. In production they
 * would be stored hashed with rotation; this function is the single point
 * to replace.
 */
export function createAuthMiddleware({ inventoryRepo, config }) {
  function authenticate(req, _res, next) {
    const key = req.get('X-API-Key');
    if (!key) throw new UnauthorizedError('Missing X-API-Key header.');

    if (key === config.adminApiKey) {
      req.auth = { type: 'admin' };
      return next();
    }

    const store = inventoryRepo.findStoreByApiKey(key);
    if (!store) throw new UnauthorizedError();

    req.auth = { type: 'store', store };
    return next();
  }

  /** Only stores may report movements. */
  function requireStore(req, _res, next) {
    if (req.auth?.type !== 'store') {
      throw new ForbiddenError(
        'STORE_KEY_REQUIRED',
        'This endpoint requires a store API key.',
      );
    }
    return next();
  }

  function requireAdmin(req, _res, next) {
    if (req.auth?.type !== 'admin') {
      throw new ForbiddenError(
        'ADMIN_KEY_REQUIRED',
        'This endpoint requires the admin API key.',
      );
    }
    return next();
  }

  /**
   * A store can only report on itself: the effective store_id always comes
   * from the API key, never from the request body. If the body disagrees,
   * the request is rejected instead of silently ignored.
   */
  function assertOwnStore(req, _res, next) {
    const claimed = req.body?.store_id;
    if (claimed && claimed !== req.auth.store.id) {
      throw new ForbiddenError(
        'STORE_MISMATCH',
        `This API key belongs to ${req.auth.store.id}, but the movement declares ${claimed}.`,
        { authenticated_store: req.auth.store.id, claimed_store: claimed },
      );
    }
    return next();
  }

  return { authenticate, requireStore, requireAdmin, assertOwnStore };
}
