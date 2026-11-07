import {
  PHASE1_PUBLIC_READS,
  isPhase1PublicRead,
} from './phase1-public-reads.js';

describe('Exact academic Phase 1 read selection', () => {
  for (const route of PHASE1_PUBLIC_READS) {
    const path = route.path.replace(/[{][^}]+[}]/g, 'fixture');
    const request = { method: route.method, path, headers: {} };
    it(
      route.operationId +
        ': explicit only, no token fallback and no phase leakage',
      () => {
        const enabled = [route.operationId];
        expect(isPhase1PublicRead(request, 'PUBLIC_READ_ONLY', enabled)).toBe(
          true,
        );
        expect(isPhase1PublicRead(request, 'PUBLIC_READ_ONLY', [])).toBe(false);
        for (const phase of [undefined, 'SIMULATED_AUTH', 'G7_AUTHENTICATED'])
          expect(isPhase1PublicRead(request, phase, enabled)).toBe(false);
        expect(
          isPhase1PublicRead(
            { ...request, headers: { authorization: 'Bearer invalid' } },
            'PUBLIC_READ_ONLY',
            enabled,
          ),
        ).toBe(false);
        expect(
          isPhase1PublicRead(
            { ...request, method: 'PATCH' },
            'PUBLIC_READ_ONLY',
            enabled,
          ),
        ).toBe(false);
        expect(
          isPhase1PublicRead(
            { ...request, path: path + '/extra' },
            'PUBLIC_READ_ONLY',
            enabled,
          ),
        ).toBe(false);
        expect(isPhase1PublicRead(request, 'PUBLIC_READ_ONLY', ['*'])).toBe(
          false,
        );
        if (route.path.includes('{sku}')) {
          const opaquePath = route.path
            .replace('{sku}', 'opaque%2Fsku')
            .replace(/[{][^}]+[}]/g, 'fixture');
          expect(
            isPhase1PublicRead(
              { ...request, path: opaquePath },
              'PUBLIC_READ_ONLY',
              enabled,
            ),
          ).toBe(true);
        }
      },
    );
  }
  it('rejects encoded separators, traversal and malformed paths before authorization', () => {
    for (const path of [
      '/api/v1/../productos',
      '/api/v1/%2e%2e/productos',
      '/api/v1/productos/%2f',
      '/api/v1/%00',
      '/api/v1/%',
      '/api/v1/\\\\',
    ])
      expect(
        isPhase1PublicRead(
          { method: 'GET', path, headers: {} },
          'PUBLIC_READ_ONLY',
          PHASE1_PUBLIC_READS.map((r) => r.operationId),
        ),
      ).toBe(false);
  });
});
