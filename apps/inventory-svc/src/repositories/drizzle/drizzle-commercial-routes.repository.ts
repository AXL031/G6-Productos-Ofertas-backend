import { Injectable } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import * as schema from '../../drizzle/schema.js';
import { ICommercialRoutesRepository } from '../interfaces/commercial-routes.repository.interface.js';

@Injectable()
export class DrizzleCommercialRoutesRepository implements ICommercialRoutesRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findActiveByChannelAndFulfillment(
    channelId: string,
    mode: string,
    fulfillmentRef: string | null,
    client?: IDatabaseClient,
  ): Promise<string | null> {
    return this.findUniqueActiveLocation(
      channelId,
      client,
      mode,
      fulfillmentRef,
    );
  }

  async findActiveByChannel(
    channelId: string,
    client?: IDatabaseClient,
  ): Promise<string | null> {
    return this.findUniqueActiveLocation(channelId, client);
  }

  private async findUniqueActiveLocation(
    channelId: string,
    client?: IDatabaseClient,
    mode?: string,
    fulfillmentRef?: string | null,
  ): Promise<string | null> {
    const conditions = [
      eq(schema.commercialFulfillmentRoutes.channel_id, channelId),
      eq(schema.commercialFulfillmentRoutes.active, true),
      eq(schema.locations.active, true),
    ];
    const params = [channelId];
    const sqlConditions = ['routes.channel_id = $1', 'routes.active = true'];
    if (mode !== undefined) {
      conditions.push(eq(schema.commercialFulfillmentRoutes.mode, mode));
      params.push(mode);
      sqlConditions.push('routes.mode = $2');
    }
    if (fulfillmentRef != null) {
      conditions.push(
        eq(schema.commercialFulfillmentRoutes.fulfillment_ref, fulfillmentRef),
      );
      params.push(fulfillmentRef);
      sqlConditions.push('routes.fulfillment_ref = $3');
    }
    const db = client?.drizzle ?? this.databaseService.getDrizzle();
    if (db) {
      const rows = await db
        .select({
          location_id: schema.commercialFulfillmentRoutes.location_id,
        })
        .from(schema.commercialFulfillmentRoutes)
        .innerJoin(
          schema.locations,
          eq(
            schema.locations.id,
            schema.commercialFulfillmentRoutes.location_id,
          ),
        )
        .where(and(...conditions))
        .limit(2);

      if (rows.length === 1) {
        return rows[0].location_id;
      }
      return null;
    }

    const sql = `
      SELECT routes.location_id FROM inventory.commercial_fulfillment_routes AS routes
      JOIN inventory.locations AS eligible_location
        ON eligible_location.id = routes.location_id AND eligible_location.active = true
      WHERE ${sqlConditions.join(' AND ')}
      LIMIT 2
    `;
    const res = client
      ? await client.query<{ location_id: string }>(sql, params)
      : await this.databaseService.query<{ location_id: string }>(sql, params);

    if (res.rows.length === 1) {
      return res.rows[0].location_id;
    }
    return null;
  }
}
