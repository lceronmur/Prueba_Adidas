import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? path.join(ROOT, 'data', 'inventory.db'),

  // Demo credential. In production this would be a hashed, rotatable
  // per-user token instead of a single shared key.
  adminApiKey: process.env.ADMIN_API_KEY ?? 'sk_admin_demo',
};
