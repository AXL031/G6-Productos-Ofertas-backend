import { Injectable } from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import * as schema from '../../drizzle/schema.js';
import {
  ILocationsRepository,
  LocationEntity,
} from '../interfaces/locations.repository.interface.js';

@Injectable()
export class DrizzleLocationsRepository implements ILocationsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findActive(client?: IDatabaseClient): Promise<LocationEntity[]> {
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const rows = await db
        .select({
          id: schema.locations.id,
          code: schema.locations.code,
          name: schema.locations.name,
          type: schema.locations.type,
          external_ref: schema.locations.external_ref,
          active: schema.locations.active,
        })
        .from(schema.locations)
        .where(eq(schema.locations.active, true))
        .orderBy(asc(schema.locations.code));

      return rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        type: r.type,
        external_ref: r.external_ref,
        active: Boolean(r.active),
      }));
    }

    const sql = `
      SELECT id, code, name, type, external_ref, active
      FROM inventory.locations
      WHERE active = true
      ORDER BY code ASC
    `;
    const res = client
      ? await client.query(sql)
      : await this.databaseService.query(sql);

    return res.rows.map((r: any) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      external_ref: r.external_ref,
      active: Boolean(r.active),
    }));
  }
}
