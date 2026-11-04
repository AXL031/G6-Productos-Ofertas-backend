import { Inject, Injectable } from '@nestjs/common';
import { PricingDatabase } from '../persistence/pricing.database.js';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { PricingOutboxRelay } from '../messaging/outbox-relay.js';

@Injectable()
export class PricingReadiness {
  constructor(
    @Inject(PricingDatabase) private readonly database: PricingDatabase,
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
    @Inject(PricingOutboxRelay) private readonly relay?: PricingOutboxRelay,
  ) {}

  check(): Promise<boolean> {
    if (!this.config.demoNoAuthEnabled && !this.config.auth)
      return Promise.resolve(false);
    if (this.config.amqpUrl && !this.relay?.available)
      return Promise.resolve(false);
    return this.database.check();
  }
}
