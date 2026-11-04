import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, lte, inArray, sql } from 'drizzle-orm';
import { AuditDatabase, type AuditTransaction } from './audit.database.js';
import { auditLog, exportJobs, inbox } from './audit.schema.js';
import {
  assertExportLimit,
  uuid,
  validateChange,
  type AuditChange,
} from '../domain/audit.js';
import {
  AuditHttpError,
  AuditPersistenceError,
} from '../http/audit-http.error.js';
import { parseFilters, type AuditFilters } from '../http/audit-query.js';

function where(filters: AuditFilters) {
  return and(
    filters.sku === undefined ? undefined : eq(auditLog.sku, filters.sku),
    filters.usuarioId === undefined
      ? undefined
      : eq(auditLog.userId, filters.usuarioId),
    filters.canal === undefined
      ? undefined
      : eq(auditLog.channel, filters.canal),
    filters.batchId === undefined
      ? undefined
      : eq(auditLog.batchId, filters.batchId),
    filters.desde === undefined
      ? undefined
      : gte(auditLog.at, new Date(filters.desde)),
    filters.hasta === undefined
      ? undefined
      : lte(auditLog.at, new Date(filters.hasta)),
  );
}
@Injectable()
export class AuditRepository {
  constructor(
    @Inject(AuditDatabase) private readonly database: AuditDatabase,
  ) {}
  async transaction<T>(
    operation: (tx: AuditTransaction) => Promise<T>,
    readonly = false,
  ): Promise<T> {
    try {
      return await this.database.db.transaction(
        operation,
        readonly
          ? { isolationLevel: 'repeatable read', accessMode: 'read only' }
          : undefined,
      );
    } catch (error) {
      if (error instanceof AuditHttpError) throw error;
      throw new AuditPersistenceError();
    }
  }
  append(
    message: { id: string; correlationId: string | null; payload: unknown },
    entries: AuditChange[],
  ) {
    if (
      !Array.isArray(entries) ||
      !entries.length ||
      !message ||
      !uuid.test(message.id) ||
      (message.correlationId !== null && !uuid.test(message.correlationId))
    )
      throw new AuditHttpError(400, 'VALIDACION');
    const changes = entries.map(validateChange);
    return this.transaction(async (tx) => {
      const [accepted] = await tx
        .insert(inbox)
        .values({
          messageId: message.id,
          correlationId: message.correlationId,
          eventName: 'pricing.price.changed',
          handler: 'price-audit-svc',
          payload: message.payload,
          result: 'PROCESSED',
        })
        .onConflictDoNothing({ target: [inbox.messageId, inbox.handler] })
        .returning({ id: inbox.id });
      if (!accepted) return { duplicate: true };
      await tx
        .insert(auditLog)
        .values(changes.map((entry) => ({ ...entry, inboxId: accepted.id })));
      return { duplicate: false };
    });
  }
  list(filters: AuditFilters, page: number, size: number) {
    return this.transaction(async (tx) => {
      const [total] = await tx
        .select({ value: count() })
        .from(auditLog)
        .where(where(filters));
      const items = await tx
        .select()
        .from(auditLog)
        .where(where(filters))
        .orderBy(desc(auditLog.at), desc(auditLog.id))
        .limit(size)
        .offset((page - 1) * size);
      return { items, total: total.value };
    }, true);
  }
  detail(id: string) {
    return this.transaction(
      async (tx) =>
        (await tx.select().from(auditLog).where(eq(auditLog.id, id)))[0],
      true,
    );
  }
  createExport(filters: AuditFilters, format: string, userId: string) {
    return this.transaction(async (tx) => {
      const [total] = await tx
        .select({ value: count() })
        .from(auditLog)
        .where(where(filters));
      assertExportLimit(format, total.value);
      const [job] = await tx
        .insert(exportJobs)
        .values({ filters, format, userId, recordCount: total.value })
        .returning();
      return job;
    });
  }
  exportJob(id: string) {
    return this.transaction(
      async (tx) =>
        (await tx.select().from(exportJobs).where(eq(exportJobs.id, id)))[0],
      true,
    );
  }
  processExport(
    write: (
      job: typeof exportJobs.$inferSelect,
      rows: (typeof auditLog.$inferSelect)[],
    ) => Promise<void>,
  ) {
    return this.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      const [job] = await tx
        .select()
        .from(exportJobs)
        .where(inArray(exportJobs.status, ['QUEUED', 'PROCESSING']))
        .orderBy(exportJobs.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!job) return false;
      try {
        // Una sola instantánea; los eventos posteriores no cambian el archivo en curso.
        await tx.transaction(async (snapshot) => {
          const { filters } = parseFilters(
            job.filters as Record<string, unknown>,
            false,
          );
          const [total] = await snapshot
            .select({
              value: count(),
              bytes: sql<string>`coalesce(sum(pg_column_size(to_jsonb(${sql.identifier('price_audit_log')}))),0)`,
            })
            .from(auditLog)
            .where(where(filters));
          assertExportLimit(job.format, total.value);
          if (Number(total.bytes) > 32 * 1024 * 1024)
            throw new Error('Exportación demasiado grande.');
          const rows = await snapshot
            .select()
            .from(auditLog)
            .where(where(filters))
            .orderBy(desc(auditLog.at), desc(auditLog.id));
          // Validar otra vez también protege contra datos inesperados en filtros persistidos.
          assertExportLimit(job.format, rows.length);
          await write(job, rows);
          await snapshot
            .update(exportJobs)
            .set({
              status: 'COMPLETED',
              recordCount: rows.length,
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(exportJobs.id, job.id));
        });
      } catch {
        await tx
          .update(exportJobs)
          .set({ status: 'FAILED_GENERAL', updatedAt: new Date() })
          .where(eq(exportJobs.id, job.id));
      }
      return true;
    });
  }
}
