// Fixed test-driver access to the internal network. Byte-transparent TCP only,
// including PostgreSQL TLS. No forwarding target is supplied by an HTTP caller.
import { createServer, connect } from 'node:net';
for (const [host, port] of [
  ['postgres', 5432],
  ['broker', 5672],
  ['catalog-svc', 3001],
  ['pricing-svc', 3002],
  ['taxonomy-svc', 3003],
  ['inventory-svc', 3005],
  ['promotions-svc', 3004],
]) {
  createServer((client) => {
    const upstream = connect({ host, port });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  }).listen(port, '0.0.0.0');
}
