import { ValidationError } from '../services/errors.js';

/**
 * Validates part of the request against a Zod schema and replaces the
 * original value with the parsed one (coercion and defaults applied).
 *
 * `req.query` is read-only in Express 5 and a plain object in Express 4;
 * writing to `req.validated` avoids depending on which one is running.
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      throw new ValidationError('The request does not match the expected schema.', {
        source,
        issues: result.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      });
    }

    req.validated = { ...(req.validated ?? {}), [source]: result.data };
    return next();
  };
}
