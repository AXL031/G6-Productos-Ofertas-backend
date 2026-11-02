import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
const token = async path => (await (await fetch('https://issuer:3443/' + path)).json()).token;
const valid = await token('valid');
const expired = await token('expired');
const forbidden = await token('forbidden');
async function check(path, expected, bearer = valid, base = 'http://api-gateway:3000') {
  const correlation = randomUUID();
  const response = await fetch(base + path, { headers: { 'x-correlation-id': correlation, ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, expected, path);
  const payload = await response.json();
  if (base.includes('api-gateway') && path.startsWith('/api/')) assert.equal(response.headers.get('x-correlation-id'), correlation);
  if (expected >= 400) {
    assert.match(response.headers.get('content-type'), /application\/problem\+json/);
    assert.equal(payload.code, ({ 400: 'VALIDACION', 401: 'TOKEN_INVALIDO', 403: 'SCOPE_INSUFICIENTE', 404: 'PRODUCTO_NO_ENCONTRADO', 503: 'SERVICIO_NO_DISPONIBLE' })[expected]);
  }
  return payload;
}
async function waitForCatalogReady() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const response = await fetch('http://catalog-svc:3001/health/ready', { signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) });
    const payload = await response.json();
    if (response.status === 200) {
      assert.equal(payload.status, 'ready');
      assert.equal(payload.service, 'catalog-svc');
      return;
    }
    assert.equal(response.status, 503, 'Unexpected Catalog readiness status during recovery');
    assert.match(response.headers.get('content-type'), /application\/problem\+json/);
    assert.equal(payload.code, 'SERVICIO_NO_DISPONIBLE');
    await pause(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  assert.fail('Catalog readiness did not recover within 30 seconds');
}
if (process.argv[2] === 'offline') {
  await check('/api/v1/categorias', 503);
  await check('/api/v1/productos?canal=MARKETPLACE&q=ci', 503);
  await check('/health/ready', 503, '', 'http://catalog-svc:3001');
  await check('/health', 200);
} else {
  assert.deepEqual((await check('/api/v1/categorias', 200)).categories, []);
  for (const path of ['/api/v1/categorias', '/api/v1/productos?canal=MARKETPLACE&q=ci', '/api/v1/productos/por-slug/inexistente?canal=MARKETPLACE']) {
    await check(path, 401, '');
    await check(path, 401, expired);
    await check(path, 403, forbidden);
  }
  assert.deepEqual(await check('/api/v1/productos?canal=MARKETPLACE&q=ci', 200), { items: [], pagina: 1, tamanio: 20, total: 0 });
  await check('/api/v1/productos/por-slug/inexistente?canal=MARKETPLACE', 404);
  await check('/api/v1/productos?canal=MARKETPLACE&pagina=0', 400);
  await check('/health/ready', 200, '', 'http://taxonomy-svc:3006');
  await waitForCatalogReady();
  await check('/health', 200, '', 'http://catalog-svc:3001');
}
console.log('PASS: Docker Marketplace ' + (process.argv[2] ?? 'online') + ' (sin elegibilidad comercial inventada)');
