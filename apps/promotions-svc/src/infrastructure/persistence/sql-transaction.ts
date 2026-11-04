export interface SqlClient {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}

export interface SqlPool {
  connect(): Promise<SqlClient>;
}

// Both the coupon command processor and Drizzle use this boundary and one pool.
export async function inPromotionsTransaction<T, C extends SqlClient>(
  pool: { connect(): Promise<C> },
  work: (client: C) => Promise<T>,
  readOnly = false,
): Promise<T> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query(
      readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
    );
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroy = true;
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}
