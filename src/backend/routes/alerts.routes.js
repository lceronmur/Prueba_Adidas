import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { alertsQuerySchema } from '../schemas/query.schema.js';
import { paginationMeta, toAlertDTO, toLimitOffset } from './presenters.js';

export function createAlertsRouter({ alertRepo }) {
  const router = Router();

  /** GET /alerts — low-stock alerts. Open ones by default. */
  router.get('/', validate(alertsQuerySchema, 'query'), (req, res) => {
    const query = req.validated.query;
    const { limit, offset, page, pageSize } = toLimitOffset(query);

    const { rows, total } = alertRepo.list({
      status: query.status === 'ALL' ? undefined : query.status,
      sku: query.sku,
      limit,
      offset,
    });

    res.json({
      data: rows.map(toAlertDTO),
      meta: { ...paginationMeta({ page, pageSize, total }), open_total: alertRepo.countOpen() },
    });
  });

  return router;
}
