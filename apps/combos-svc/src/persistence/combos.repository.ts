import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { CombosDatabase } from './combos.database.js';
import { combos, comboItems, componentProjection } from './combos.schema.js';

export interface ComboComponentRecord {
  id: string;
  sku: string;
  quantity: number;
}
export interface ComboAggregate {
  combo: typeof combos.$inferSelect;
  components: ComboComponentRecord[];
}
export interface NewCombo {
  name: string;
  description: string | null;
  price: string;
  currency: string;
  components: Array<{ sku: string; quantity: number }>;
}
export interface ComboPatch {
  name: string;
  description: string | null;
  price: string;
  currency: string;
  expectedVersion: bigint;
  components?: Array<{ sku: string; quantity: number }>;
}

@Injectable()
export class CombosRepository {
  constructor(private readonly database: CombosDatabase) {}

  private throwIfUnavailable(error: unknown): never {
    let current: unknown = error;
    let code = '';
    for (let depth = 0; depth < 4; depth += 1) {
      if (typeof current !== 'object' || current === null) break;
      if ('code' in current) code = String(current.code);
      if (!('cause' in current)) break;
      current = current.cause;
    }
    if (
      code.startsWith('08') ||
      code.startsWith('ECONN') ||
      code === 'ETIMEDOUT'
    )
      throw new ServiceUnavailableException(
        'Servicio temporalmente no disponible',
      );
    throw error;
  }

  private async componentRows(id: string): Promise<ComboComponentRecord[]> {
    return this.database
      .drizzle()
      .select({
        id: comboItems.id,
        sku: comboItems.sku,
        quantity: comboItems.quantity,
      })
      .from(comboItems)
      .where(eq(comboItems.comboId, id))
      .orderBy(asc(comboItems.createdAt), asc(comboItems.id));
  }

  async get(id: string): Promise<ComboAggregate | undefined> {
    try {
      const [combo] = await this.database
        .drizzle()
        .select()
        .from(combos)
        .where(eq(combos.id, id))
        .limit(1);
      if (!combo) return undefined;
      return { combo, components: await this.componentRows(id) };
    } catch (error) {
      return this.throwIfUnavailable(error);
    }
  }

  async list(input: {
    page: number;
    size: number;
    status?: 'ACTIVO' | 'INACTIVO';
  }): Promise<{ items: ComboAggregate[]; total: number }> {
    try {
      const conditions = input.status ? [eq(combos.status, input.status)] : [];
      const where = conditions.length ? and(...conditions) : undefined;
      const [count] = await this.database
        .drizzle()
        .select({ total: sql<number>`count(*)::int` })
        .from(combos)
        .where(where);
      const rows = await this.database
        .drizzle()
        .select()
        .from(combos)
        .where(where)
        .orderBy(desc(combos.createdAt), asc(combos.id))
        .limit(input.size)
        .offset((input.page - 1) * input.size);
      const items = await Promise.all(
        rows.map(async (combo) => ({
          combo,
          components: await this.componentRows(combo.id),
        })),
      );
      return { items, total: count?.total ?? 0 };
    } catch (error) {
      return this.throwIfUnavailable(error);
    }
  }

  async create(input: NewCombo): Promise<string> {
    try {
      return await this.database.drizzle().transaction(async (tx) => {
        const [combo] = await tx
          .insert(combos)
          .values({
            name: input.name,
            description: input.description,
            comboPrice: input.price,
            currency: input.currency,
          })
          .returning({ id: combos.id });
        if (!combo) throw new Error('COMBO_INSERT_FAILED');
        await tx.insert(comboItems).values(
          input.components.map((component) => ({
            comboId: combo.id,
            sku: component.sku,
            quantity: component.quantity,
          })),
        );
        return combo.id;
      });
    } catch (error) {
      return this.throwIfUnavailable(error);
    }
  }

  async update(id: string, patch: ComboPatch): Promise<boolean> {
    try {
      return await this.database.drizzle().transaction(async (tx) => {
        const changed = await tx
          .update(combos)
          .set({
            name: patch.name,
            description: patch.description,
            comboPrice: patch.price,
            currency: patch.currency,
            version: sql`${combos.version} + 1`,
          })
          .where(
            and(
              eq(combos.id, id),
              eq(combos.version, patch.expectedVersion),
              eq(combos.status, 'ACTIVO'),
            ),
          )
          .returning({ id: combos.id });
        if (!changed.length) return false;
        if (patch.components !== undefined) {
          await tx.delete(comboItems).where(eq(comboItems.comboId, id));
          await tx.insert(comboItems).values(
            patch.components.map((component) => ({
              comboId: id,
              sku: component.sku,
              quantity: component.quantity,
            })),
          );
        }
        return true;
      });
    } catch (error) {
      return this.throwIfUnavailable(error);
    }
  }

  async deactivate(id: string): Promise<boolean> {
    try {
      const updated = await this.database
        .drizzle()
        .update(combos)
        .set({ status: 'INACTIVO', version: sql`${combos.version} + 1` })
        .where(eq(combos.id, id))
        .returning({ id: combos.id });
      return updated.length > 0;
    } catch (error) {
      return this.throwIfUnavailable(error);
    }
  }

  async projections(id: string) {
    try {
      return this.database
        .drizzle()
        .select({
          id: comboItems.id,
          sku: comboItems.sku,
          quantity: comboItems.quantity,
          catalogDeactivated: componentProjection.catalogDeactivated,
          catalogObservedAt: componentProjection.catalogObservedAt,
          projectedAvailable: componentProjection.projectedAvailable,
          inventoryObservedAt: componentProjection.inventoryObservedAt,
        })
        .from(comboItems)
        .leftJoin(
          componentProjection,
          eq(componentProjection.comboItemId, comboItems.id),
        )
        .where(eq(comboItems.comboId, id))
        .orderBy(asc(comboItems.sku));
    } catch (error) {
      return this.throwIfUnavailable(error);
    }
  }
}
