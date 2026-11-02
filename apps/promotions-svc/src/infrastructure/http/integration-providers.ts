import {
  blockedCommercialContext,
  type CommercialContext,
} from '../../domain/commercial-context.js';
import {
  blockedAdminReferences,
  type AdminReferences,
} from '../../domain/admin-references.js';
import type { PromotionsConfigService } from '../config/promotions-config.js';
import { HttpCommercialContext } from './commercial-http.js';
import { HttpAdminReferences } from './admin-references-http.js';
import type {
  InternalHttpOptions,
  ServiceAccessTokenSource,
} from './internal-http.js';

export const PROMOTIONS_SERVICE_TOKENS = Symbol('PROMOTIONS_SERVICE_TOKENS');
// A real G7 integration can override this source later. Never forward user bearer.
export const unavailableServiceTokens: ServiceAccessTokenSource = async () =>
  null;
function options(
  config: PromotionsConfigService,
  tokens: ServiceAccessTokenSource,
): InternalHttpOptions {
  return {
    origin: config.settings.upstreams.catalog!,
    origins: config.settings.upstreams,
    mode: config.settings.localDemoEnabled
      ? 'RESTRICTED_DEMO'
      : 'AUTHENTICATED',
    getServiceAccessToken: tokens,
  };
}
export function commercialProvider(
  config: PromotionsConfigService,
  tokens: ServiceAccessTokenSource,
): CommercialContext {
  const u = config.settings.upstreams;
  return u.catalog && u.pricing && u.inventory
    ? new HttpCommercialContext(options(config, tokens))
    : blockedCommercialContext;
}
export function adminReferenceProvider(
  config: PromotionsConfigService,
  tokens: ServiceAccessTokenSource,
): AdminReferences {
  const u = config.settings.upstreams;
  return u.catalog && u.taxonomy
    ? new HttpAdminReferences(options(config, tokens))
    : blockedAdminReferences;
}
