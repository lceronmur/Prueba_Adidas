import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { config as defaultConfig } from './config.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createErrorHandler, notFound, requestId } from './middleware/errorHandler.js';
import { createAlertRepo } from './repositories/alert.repo.js';
import { createInventoryRepo } from './repositories/inventory.repo.js';
import { createMovementRepo } from './repositories/movement.repo.js';
import { createAdminRouter } from './routes/admin.routes.js';
import { createAlertsRouter } from './routes/alerts.routes.js';
import { createInventoryRouter } from './routes/inventory.routes.js';
import { createMovementsRouter } from './routes/movements.routes.js';
import { createAlertService } from './services/alert.service.js';
import { createInventoryService } from './services/inventory.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(here, '../frontend');

/**
 * Composes the application from an already-open database connection.
 *
 * Taking `db` as a parameter instead of importing it is what lets every
 * test spin up its own in-memory database without touching env vars or files.
 */
export function createApp(db, overrides = {}) {
  const config = { ...defaultConfig, ...overrides };

  // Explicit composition: repositories -> services -> routes.
  const inventoryRepo = createInventoryRepo(db);
  const movementRepo = createMovementRepo(db);
  const alertRepo = createAlertRepo(db);

  const alertService = createAlertService({ inventoryRepo, alertRepo });
  const inventoryService = createInventoryService({
    db, inventoryRepo, movementRepo, alertService,
  });

  const auth = createAuthMiddleware({ inventoryRepo, config });

  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(express.json({ limit: '1mb' }));

  // Public: confirms the process is alive without exposing any data.
  app.get('/api/v1/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime_s: Math.round(process.uptime()),
      open_alerts: alertRepo.countOpen(),
    });
  });

  // Everything below requires a valid API key.
  const api = express.Router();
  api.use(auth.authenticate);
  api.use('/movements', createMovementsRouter({ inventoryService, inventoryRepo, auth }));
  api.use('/inventory', createInventoryRouter({ inventoryService, alertRepo }));
  api.use('/alerts', createAlertsRouter({ alertRepo }));
  api.use('/', createAdminRouter({ inventoryService, auth }));
  app.use('/api/v1', api);

  // Demo panel: static, no build step, same process.
  app.use(express.static(FRONTEND_DIR));

  app.use(notFound);
  app.use(createErrorHandler({ logger: config.logger ?? console }));

  return app;
}
