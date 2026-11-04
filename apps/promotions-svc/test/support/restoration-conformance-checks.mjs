import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// D-04's bilateral sender profile always carries the original operation.
// rc.3 still permits omission/null globally; this test does not tighten it.
export async function verifyRestorationConformance({
  processor,
  admin,
  command,
  restore,
}) {
  const original = command();
  const other = command();
  const consumed = await processor.process(original, 'modulo-ventas');
  const foreign = await processor.process(other, 'modulo-ventas');
  assert.match(consumed.name, /consumption.completed$/);
  assert.match(foreign.name, /consumption.completed$/);
  const uses = async () =>
    (
      await admin.query(
        'SELECT id,order_id,restored_at,updated_at FROM promotions.coupon_uses WHERE order_id=ANY($1::text[]) ORDER BY id',
        [[original.data.order_id, other.data.order_id]],
      )
    ).rows;
  const before = await uses();
  for (const reference of [randomUUID(), other.operation_id]) {
    const rejected = await processor.process(
      restore(original, reference),
      'modulo-ventas',
    );
    assert.equal(rejected.data.result_code, 'COUPON_IDENTITY_MISMATCH');
    assert.deepEqual(await uses(), before);
  }
  const restoration = restore(original);
  const restored = await processor.process(restoration, 'modulo-ventas');
  assert.equal(restored.data.outcome, 'RESTORED');
  assert.equal(restored.data.consumption_operation_id, original.operation_id);
  const after = await uses();
  assert.equal(
    after
      .find((r) => r.order_id === original.data.order_id)
      .restored_at.getTime(),
    Date.parse(restoration.data.cancelled_at),
  );
  assert.equal(
    after.find((r) => r.order_id === other.data.order_id).restored_at,
    null,
  );
  assert.deepEqual(
    await processor.process(
      { ...restoration, message_id: randomUUID() },
      'modulo-ventas',
    ),
    restored,
  );
  assert.deepEqual(await uses(), after);
  const changed = {
    ...restoration,
    message_id: randomUUID(),
    data: { ...restoration.data, consumption_operation_id: other.operation_id },
  };
  assert.equal(
    (await processor.process(changed, 'modulo-ventas')).data.result_code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.deepEqual(await uses(), after);
  for (const [table, where, value] of [
    ['coupon_command_receipts', 'operation_id', restoration.operation_id],
    ['outbox', 'message_id', restored.message_id],
  ]) {
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM promotions.${table} WHERE ${where}=$1`,
          [value],
        )
      ).rows[0].n,
      1,
    );
  }
  return 'D-04 sender profile conformance in real PG: original operation valid/unknown/foreign, stable duplicate returns identical result, changed duplicate conflicts; one restoration effect and result, rc.3 optional parser unchanged';
}
