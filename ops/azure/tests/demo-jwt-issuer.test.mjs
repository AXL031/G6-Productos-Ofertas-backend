import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoIssuer } from '../demo-jwt-issuer.mjs';

test('local development issuer never binds publicly or emits privileged/unauthenticated tokens', async () => {
  const adminSecret = 'fixture-admin-secret-2026';
  const clientSecret = 'fixture-client-secret-2026';
  assert.throws(() => createDemoIssuer({ adminSecret: 'short' }), /DEMO_ISSUER_CONFIG_INVALID/);
  const demo = createDemoIssuer({ adminSecret, clients: {
    'modulo-productos': { clientSecret, allowedScopes: ['catalogo:leer','tokens:introspeccion'] },
  } });
  for (const privateField of ['d', 'p', 'q']) assert.equal(privateField in demo.publicJwk, false);
  await assert.rejects(demo.listenLocalOnly('0.0.0.0', 0), /PUBLIC_BIND_FORBIDDEN/);
  assert.throws(() => demo.mintProfile({ issuer: 'http://localhost', profile: 'user-gestor', secret: 'wrong' }), /UNAUTHORIZED_MINT/);
  for (const profile of ['user-gestor','user-sin-rol']) {
    const token = demo.mintProfile({issuer:'https://simulator.test',profile,secret:adminSecret});
    const claims = JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
    assert.equal(claims.tipo,'acceso');
    assert.equal(Object.hasOwn(claims,'aud'),false);
    assert.match(claims.sub,/^[0-9a-f-]{36}$/i);
  }
  const server = await demo.listenLocalOnly('127.0.0.1', 0);
  try {
    for (const [overrides, status] of [
      [{ client_secret: 'wrong' }, 401], [{ roles: 'GESTOR_COMERCIAL' }, 403],
      [{ tipo: 'acceso' }, 403], [{ scope: 'other:scope' }, 403], [{}, 200],
    ]) {
      const response = await fetch(server.tokenUrl, { method: 'POST', body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: 'modulo-productos', client_secret: clientSecret,
        scope: 'catalogo:leer', ...overrides,
      }) });
      assert.equal(response.status, status);
      const body = await response.json();
      if (status === 200) {
        assert.equal(body.tokenType, 'Bearer');
        assert.deepEqual(body.scopes, ['catalogo:leer']);
      }
    }
    for (const [scope,status,audience] of [
      ['tokens:introspeccion',200,'api-seguridad'],
      ['tokens:introspeccion catalogo:leer',403,undefined],
    ]) {
      const response = await fetch(server.tokenUrl,{method:'POST',body:new URLSearchParams({
        grant_type:'client_credentials',client_id:'modulo-productos',client_secret:clientSecret,scope,
      })});
      assert.equal(response.status,status);
      if (status === 200) {
        const body = await response.json();
        const claims = JSON.parse(Buffer.from(body.accessToken.split('.')[1],'base64url').toString());
        assert.equal(claims.aud,audience); assert.equal(claims.scope,scope);
        assert.equal(claims.client_id,'modulo-productos');
      }
    }
  } finally { await server.close(); }
});
