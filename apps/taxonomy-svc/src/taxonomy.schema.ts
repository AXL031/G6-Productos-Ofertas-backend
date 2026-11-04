import {
  pgSchema,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
} from 'drizzle-orm/pg-core';

const taxonomy = pgSchema('taxonomy');
export const categories = taxonomy.table('categories', {
  id: uuid('id').notNull(),
  nombre: text('nombre').notNull(),
  descripcion: text('descripcion'),
  categoria_padre_id: uuid('categoria_padre_id'),
  orden: integer('orden').notNull(),
  imagen_url: text('imagen_url'),
  estado: text('estado')
    .$type<'ACTIVO' | 'INACTIVO' | 'PENDING_DEACTIVATION'>()
    .notNull(),
  taxonomy_version: bigint('taxonomy_version', { mode: 'number' }).notNull(),
});
export const categorySeo = taxonomy.table('category_seo', {
  categoria_id: uuid('categoria_id').notNull(),
  slug: text('slug').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
});
export const brands = taxonomy.table('brands', {
  id: uuid('id').notNull(),
  nombre: text('nombre').notNull(),
  descripcion: text('descripcion'),
  pais_origen_iso: text('pais_origen_iso'),
  logo_url: text('logo_url'),
  estado: text('estado')
    .$type<'ACTIVO' | 'INACTIVO' | 'PENDING_DEACTIVATION'>()
    .notNull(),
});
