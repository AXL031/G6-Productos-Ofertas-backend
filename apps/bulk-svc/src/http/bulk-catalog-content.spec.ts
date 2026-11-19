import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { expect, it, vi } from 'vitest';
import request from 'supertest';
import { BulkPersistenceRepository } from '../persistence/bulk.repository.js';
import { BulkCatalogContentController } from './bulk-catalog-content.controller.js';

it('requires the Catalog service grant and returns the saved bytes with hash and length', async () => {
  const issuer = 'https://g7.private.test';
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  vi.stubEnv('G6_SECURITY_MODE', 'G7_AUTHENTICATED');
  vi.stubEnv('G7_JWT_ISSUER', issuer);
  vi.stubEnv('G7_JWT_JWKS_URL', undefined);
  vi.stubEnv(
    'G7_JWT_PUBLIC_KEY',
    publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );
  vi.stubEnv('BULK_CATALOG_CONTENT_ENABLED', 'true');
  const contentId = randomUUID();
  const bytes = Buffer.from('{ "rows": [{"sku_base":"ñ"}] }');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const findCatalogContent = vi.fn(async (id: string) =>
    id === contentId ? { bytes, sha256 } : null,
  );
  const module = await Test.createTestingModule({
    controllers: [BulkCatalogContentController],
    providers: [
      { provide: BulkPersistenceRepository, useValue: { findCatalogContent } },
    ],
  }).compile();
  const app = module.createNestApplication();
  function bearer(claims: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    const encoded = [
      { alg: 'RS256' },
      {
        iss: issuer,
        iat: now,
        exp: now + 60,
        jti: randomUUID(),
        sub: 'catalog-svc',
        tipo: 'servicio',
        aud: 'api-productos',
        scope: 'carga-masiva:contenidos:leer',
        ...claims,
      },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
      .join('.');
    return (
      'Bearer ' +
      encoded +
      '.' +
      sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')
    );
  }
  const path = '/api/v1/interno/carga-masiva/contenidos/';
  try {
    await app.init();
    const api = request(app.getHttpServer());
    await api.get(path + contentId).expect(401);
    await api
      .get(path + contentId)
      .set('Authorization', bearer({ sub: 'otro-servicio' }))
      .expect(403);
    await api
      .get(path + contentId)
      .set('Authorization', bearer({ aud: 'otro' }))
      .expect(403);
    await api
      .get(path + contentId)
      .set('Authorization', bearer({ scope: 'catalogo:leer' }))
      .expect(403);
    await api
      .get(path + contentId)
      .set('Authorization', bearer({ client_id: 'otro-servicio' }))
      .expect(403);
    expect(findCatalogContent).not.toHaveBeenCalled();
    const response = await api
      .get(path + contentId)
      .set('Authorization', bearer())
      .expect(200)
      .expect('Content-Length', String(bytes.length))
      .expect('X-Content-SHA256', sha256)
      .expect('Cache-Control', 'no-store');
    expect(response.text).toBe(bytes.toString('utf8'));
    await api
      .get(path + randomUUID())
      .set('Authorization', bearer())
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('ARCHIVO_NO_ENCONTRADO'));
    vi.stubEnv('BULK_CATALOG_CONTENT_ENABLED', 'false');
    await api
      .get(path + contentId)
      .set('Authorization', bearer())
      .expect(404);
  } finally {
    await app.close();
    vi.unstubAllEnvs();
  }
});
