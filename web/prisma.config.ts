import path from 'node:path';
import { defineConfig } from 'prisma/config';

// Migrations run against the direct (unpooled) Neon endpoint; `prisma generate`
// needs no database, so an unset URL is allowed here.
export default defineConfig({
  schema: path.join(import.meta.dirname, 'prisma', 'schema.prisma'),
  migrations: { path: path.join(import.meta.dirname, 'prisma', 'migrations') },
  datasource: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '' },
});
