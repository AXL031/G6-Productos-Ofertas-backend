import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../drizzle/schema.js';
import { DatabaseService } from '../../database/database.service.js';
import { DrizzleCommercialRoutesRepository } from './drizzle-commercial-routes.repository.js';

describe('Resolución comercial con Drizzle (#25/#98)', () => {
  const locationId = '9129b578-631e-1735-8427-b683fb524380';

  function createRepository(rows: string[][] = [[locationId]]) {
    // Se usa el generador SQL real de Drizzle con un cliente PG de prueba, sin red.
    const query = vi.fn(async (_config: unknown, _params: unknown[]) => ({
      rows,
    }));
    const db = drizzle({ query } as unknown as pg.Pool, { schema });
    const database = new DatabaseService();
    vi.spyOn(database, 'getDrizzle').mockReturnValue(db);
    return {
      repository: new DrizzleCommercialRoutesRepository(database),
      query,
    };
  }

  it('consulta la referencia y modalidad exactas en una ubicación activa', async () => {
    const { repository, query } = createRepository();
    expect(
      await repository.findActiveByChannelAndFulfillment(
        'MARKETPLACE',
        'RETIRO_TIENDA',
        'TIENDA-01',
      ),
    ).toBe(locationId);
    const [{ text }, params] = query.mock.calls[0] as [
      { text: string },
      unknown[],
    ];
    expect(text).toContain('inner join "inventory"."locations"');
    expect(text).toContain('"locations"."active"');
    expect(text).toContain('"commercial_fulfillment_routes"."mode"');
    expect(text).toContain('"commercial_fulfillment_routes"."fulfillment_ref"');
    expect(params).toEqual([
      'MARKETPLACE',
      true,
      true,
      'RETIRO_TIENDA',
      'TIENDA-01',
      2,
    ]);
  });

  it('sin referencia filtra por canal y modalidad sin inventar un valor de referencia', async () => {
    const { repository, query } = createRepository();
    expect(
      await repository.findActiveByChannelAndFulfillment(
        'MARKETPLACE',
        'ENVIO_DOMICILIO',
        null,
      ),
    ).toBe(locationId);
    expect(query.mock.calls[0][1]).toEqual([
      'MARKETPLACE',
      true,
      true,
      'ENVIO_DOMICILIO',
      2,
    ]);
  });

  it.each([
    { rows: [] },
    { rows: [[locationId], ['aea2f0d8-e8c6-b09c-8e7a-b4a3630bc485']] },
  ])(
    'no escoge una ubicación ante mapeo ausente o ambiguo: %j',
    async ({ rows }) => {
      const { repository } = createRepository(rows);
      expect(await repository.findActiveByChannel('MARKETPLACE')).toBeNull();
    },
  );
});
