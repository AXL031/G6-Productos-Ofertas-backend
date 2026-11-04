import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const contract = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (contract.info.version !== '0.6.0-rc.3')
  throw new Error('UNEXPECTED_CONTRACT_VERSION');
const sourceHash = createHash('sha256')
  .update(readFileSync(process.argv[2].replace(/\.json$/, '.yaml')))
  .digest('hex');
const names = [
  'PromotionsCouponConsumptionRequested',
  'PromotionsCouponRestorationRequested',
  'PromotionsCouponConsumptionCompleted',
  'PromotionsCouponConsumptionRejected',
  'PromotionsCouponRestorationCompleted',
  'PromotionsCouponRestorationRejected',
];
function dereference(value) {
  if (Array.isArray(value)) return value.map(dereference);
  if (value === null || typeof value !== 'object') return value;
  if (value.$ref) {
    if (!value.$ref.startsWith('#/components/schemas/'))
      throw new Error('UNEXPECTED_REFERENCE');
    return dereference(
      contract.components.schemas[value.$ref.split('/').at(-1)],
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, dereference(item)]),
  );
}
const messages = Object.fromEntries(
  names.map((name) => {
    const message = contract.components.messages[name];
    return [
      message.name,
      {
        exchange: message['x-exchange'],
        routingKey: message['x-routing-key'],
        schema: dereference(message.payload),
      },
    ];
  }),
);
writeFileSync(
  fileURLToPath(
    new URL('../src/coupons/coupon-contract.generated.ts', import.meta.url),
  ),
  '// Generated from G6 Docs 51a5ce6e76bb0c61d93ef47416e46797bf5b9846, AsyncAPI 0.6.0-rc.3.\n' +
    `// Source SHA-256: ${sourceHash}\n` +
    "import type { MessageContract } from './schema-validator.js';\n" +
    'export const couponContracts: Readonly<Record<string, MessageContract>> = ' +
    JSON.stringify(messages, null, 2) +
    ';\n',
);
const assigned = Object.fromEntries(
  Object.values(contract.components.messages)
    .filter(
      (message) =>
        message['x-consumers']?.includes('promotions-svc') &&
        message['x-producer'] !== 'modulo-ventas',
    )
    .map((message) => [
      message.name,
      {
        producer: message['x-producer'],
        exchange: message['x-exchange'],
        routingKey: message['x-routing-key'],
        schema: dereference(message.payload),
      },
    ]),
);
if (Object.keys(assigned).length !== 4)
  throw new Error('UNEXPECTED_ASSIGNED_EVENTS');
const [queue, binding] =
  Object.entries(contract['x-rabbitmq-topology'].queues).find(
    ([, entry]) =>
      entry.consumer === 'promotions-svc' && Array.isArray(entry.bindings),
  ) ?? [];
if (!queue || binding.prefetch !== 20 || binding.bindings.length !== 6)
  throw new Error('UNEXPECTED_PROMOTIONS_BINDING');
writeFileSync(
  fileURLToPath(
    new URL('../src/coupons/event-contract.generated.ts', import.meta.url),
  ),
  '// Generated from G6 Docs 51a5ce6e76bb0c61d93ef47416e46797bf5b9846, AsyncAPI 0.6.0-rc.3.\n' +
    `// Source SHA-256: ${sourceHash}\n` +
    "import type { MessageContract } from './schema-validator.js';\n" +
    'export const promotionsBrokerBinding = ' +
    JSON.stringify(
      { queue, prefetch: binding.prefetch, bindings: binding.bindings },
      null,
      2,
    ) +
    ' as const;\n' +
    'export const assignedEventContracts: Readonly<Record<string, MessageContract & { producer: string }>> = ' +
    JSON.stringify(assigned, null, 2) +
    ';\n',
);
