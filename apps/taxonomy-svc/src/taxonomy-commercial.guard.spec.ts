import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  TaxonomyCommercialGuard,
  type TaxonomyPrincipal,
} from './taxonomy-auth.js';

function context(principal?: TaxonomyPrincipal): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ taxonomyUser: principal }) }),
  } as unknown as ExecutionContext;
}

describe('autorización comercial', () => {
  const user = {
    kind: 'user',
    subject: 'usuario',
    audiences: ['api-productos'],
    roles: ['GESTOR_COMERCIAL'],
  } as const;
  it('autoriza al gestor comercial autenticado', () => {
    expect(new TaxonomyCommercialGuard().canActivate(context(user))).toBe(true);
  });
  it.each([
    undefined,
    { ...user, roles: [] },
    {
      kind: 'service',
      subject: 'servicio',
      audiences: ['api-productos'],
      scopes: ['catalogo:leer'],
    } as const,
  ])('deniega un principal sin rol comercial', (principal) => {
    expect(() =>
      new TaxonomyCommercialGuard().canActivate(context(principal)),
    ).toThrow(ForbiddenException);
  });
});
