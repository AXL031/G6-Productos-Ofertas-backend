import { createEnvironmentFixture } from '../../../test/support/environment.js';
import {
  PromotionsConfigService,
  validatePromotionsConfiguration,
} from '../config/promotions-config.js';
import {
  commercialProvider,
  adminReferenceProvider,
  unavailableServiceTokens,
} from './integration-providers.js';
import { HttpCommercialContext } from './commercial-http.js';
import { HttpAdminReferences } from './admin-references-http.js';
import { blockedCommercialContext } from '../../domain/commercial-context.js';
import { blockedAdminReferences } from '../../domain/admin-references.js';

describe('Configured integration providers', () => {
  const fixture = createEnvironmentFixture();
  afterAll(() => fixture.cleanup());
  it('keeps each missing integration explicit rather than returning empty facts', () => {
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration(fixture.environment),
    );
    expect(commercialProvider(config, unavailableServiceTokens)).toBe(
      blockedCommercialContext,
    );
    expect(adminReferenceProvider(config, unavailableServiceTokens)).toBe(
      blockedAdminReferences,
    );
  });
  it('wires concrete clients when their own required URLs are present', () => {
    const config = new PromotionsConfigService(
      validatePromotionsConfiguration({
        ...fixture.environment,
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
        GATEWAY_CATALOG_SVC_URL: 'http://catalog-svc:3001',
        GATEWAY_PRICING_SVC_URL: 'http://pricing-svc:3002',
        GATEWAY_INVENTORY_SVC_URL: 'http://inventory-svc:3005',
        GATEWAY_TAXONOMY_SVC_URL: 'http://taxonomy-svc:3006',
      }),
    );
    expect(commercialProvider(config, unavailableServiceTokens)).toBeInstanceOf(
      HttpCommercialContext,
    );
    expect(
      adminReferenceProvider(config, unavailableServiceTokens),
    ).toBeInstanceOf(HttpAdminReferences);
  });
});
