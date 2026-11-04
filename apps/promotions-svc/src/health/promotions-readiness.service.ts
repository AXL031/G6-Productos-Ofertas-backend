import { Inject, Injectable } from '@nestjs/common';
import { withDeadline } from '../infrastructure/resilience/deadline.js';

export const PROMOTIONS_DEPENDENCY_PROBES = Symbol(
  'PROMOTIONS_DEPENDENCY_PROBES',
);

export interface DependencyProbe {
  check(signal: AbortSignal): Promise<void>;
}

export type PromotionsDependencyProbes = Readonly<
  Partial<Record<'database' | 'broker', DependencyProbe | 'disabled'>>
>;

type DependencyStatus = 'up' | 'down' | 'not_implemented' | 'disabled';
export interface PromotionsReadiness {
  status: 'ready' | 'not_ready';
  service: 'promotions-svc';
  dependencies: { database: DependencyStatus; broker: DependencyStatus };
}

@Injectable()
export class PromotionsReadinessService {
  private draining = false;
  private readonly pending = new Map<boolean, Promise<PromotionsReadiness>>();
  constructor(
    @Inject(PROMOTIONS_DEPENDENCY_PROBES)
    private readonly probes: PromotionsDependencyProbes,
  ) {}

  async check(brokerRequired = true): Promise<PromotionsReadiness> {
    if (this.draining)
      return {
        status: 'not_ready',
        service: 'promotions-svc',
        dependencies: { database: 'disabled', broker: 'disabled' },
      };
    const existing = this.pending.get(brokerRequired);
    if (existing) return existing;
    const checking = this.performCheck(brokerRequired);
    this.pending.set(brokerRequired, checking);
    try {
      return await checking;
    } finally {
      if (this.pending.get(brokerRequired) === checking)
        this.pending.delete(brokerRequired);
    }
  }

  beforeApplicationShutdown(): void {
    this.draining = true;
  }

  private async performCheck(
    brokerRequired: boolean,
  ): Promise<PromotionsReadiness> {
    const [database, broker] = await Promise.all([
      this.checkDependency(this.probes.database),
      brokerRequired
        ? this.checkDependency(this.probes.broker)
        : Promise.resolve('disabled' as const),
    ]);
    return {
      status:
        !this.draining &&
        database === 'up' &&
        (!brokerRequired || broker === 'up')
          ? 'ready'
          : 'not_ready',
      service: 'promotions-svc',
      dependencies: { database, broker },
    };
  }

  private async checkDependency(
    probe: DependencyProbe | 'disabled' | undefined,
  ): Promise<DependencyStatus> {
    if (!probe) return 'not_implemented';
    if (probe === 'disabled') return 'disabled';
    try {
      await withDeadline((signal) => probe.check(signal), 1000);
      return 'up';
    } catch {
      return 'down';
    }
  }
}
