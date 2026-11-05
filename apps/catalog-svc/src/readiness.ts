import {
  Controller,
  Get,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { pathToFileURL } from 'node:url';

export const CATALOG_DATABASE = Symbol('CATALOG_DATABASE');
export const READINESS_TIMEOUT_MS = 2000;

export type ReadinessCheckOutcome = 'ready' | 'not_ready' | 'timed_out';
export type ReadinessStage =
  'database' | 'catalog-read' | 'pricing' | 'commercial';

export function withReadinessDeadline(
  work: Promise<void>,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<ReadinessCheckOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed: Promise<ReadinessCheckOutcome> = work.then(
    () => 'ready' as const,
    () => 'not_ready' as const,
  );
  const deadline = new Promise<ReadinessCheckOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), timeoutMs);
  });
  return Promise.race([completed, deadline]).finally(() => clearTimeout(timer));
}

export interface CliReadinessConfig {
  readonly marketplaceDemoPreview: boolean;
  readonly readDemo: { readonly enabled: boolean };
}

export async function runReadinessCliProbe(
  check: (onProgress: (stage: ReadinessStage) => void) => Promise<void>,
  close: () => Promise<void>,
  config: CliReadinessConfig,
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  let database = 'not_ready';
  let status = 'not_ready';
  let eligibilityStatus = 'unverified';
  let pricingStatus = 'not_checked';
  const work = Promise.resolve().then(() =>
    check((stage) => {
      if (stage === 'database') database = 'ready';
      if (stage === 'catalog-read') {
        if (config.readDemo.enabled) eligibilityStatus = 'not_evaluated_demo';
        else eligibilityStatus = 'not_required_demo';
      }
      if (stage === 'pricing') pricingStatus = 'ready';
      if (stage === 'commercial') eligibilityStatus = 'ready';
    }),
  );

  let outcome = await withReadinessDeadline(work);
  if (outcome === 'timed_out') {
    // Drain the in-flight DB/HTTP operation before closing Nest and its pool.
    // The functional deadline is 2 s; safe shutdown can take longer.
    await work.then(
      () => undefined,
      () => undefined,
    );
  }
  if (outcome === 'ready') status = 'ready';
  else if (
    config.marketplaceDemoPreview &&
    database === 'ready' &&
    eligibilityStatus === 'not_required_demo'
  )
    pricingStatus = 'unavailable';

  try {
    await close();
  } catch {
    outcome = 'not_ready';
    status = 'not_ready';
  }

  write(
    JSON.stringify({
      service: 'catalog-svc',
      status,
      database,
      eligibility: eligibilityStatus,
      ...(config.marketplaceDemoPreview && !config.readDemo.enabled
        ? { pricing: pricingStatus }
        : {}),
    }),
  );
  return outcome === 'ready' && status === 'ready' ? 0 : 1;
}

/** The persistence adapter must execute an authenticated, read-only DB query. */
export interface CatalogDatabase {
  check(): Promise<void>;
}

@Injectable()
export class UnconfiguredDatabase implements CatalogDatabase {
  async check(): Promise<void> {
    throw new Error('Catalog database adapter is not configured');
  }
}

@Controller('health')
export class ReadinessController {
  private inFlight?: Promise<void>;
  constructor(
    @Inject(CATALOG_DATABASE) private readonly database: CatalogDatabase,
  ) {}

  @Get('ready')
  async ready() {
    if (!this.inFlight) {
      const work = Promise.resolve().then(() => this.database.check());
      this.inFlight = withReadinessDeadline(work).then((outcome) => {
        if (outcome !== 'ready') throw new Error('Readiness unavailable');
      });
      // A deadline bounds the response, not cancellation of the shared PG pool.
      // Keep the rejected flight until the underlying work drains: no new checks
      // can accumulate behind a slow dependency, and late success is never cached.
      const drained = () => {
        this.inFlight = undefined;
      };
      void work.then(drained, drained);
    }
    try {
      await this.inFlight;
      return { status: 'ready', service: 'catalog-svc' };
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        service: 'catalog-svc',
      });
    }
  }
}

async function runReadinessProbe(): Promise<void> {
  const [
    { NestFactory },
    { AppModule },
    { CatalogConfig },
    { ReadinessController: CommercialReadinessController },
  ] = await Promise.all([
    import('@nestjs/core'),
    import('./app.module.js'),
    import('./config.js'),
    import('./readiness.controller.js'),
  ]);
  const config = new CatalogConfig(process.env);
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot(config),
    {
      logger: false,
      abortOnError: false,
    },
  );
  process.exitCode = await runReadinessCliProbe(
    (onProgress) =>
      app.get(CommercialReadinessController).checkReadiness(onProgress),
    () => app.close(),
    config,
  );
}

// Finish evaluating this module before the CLI imports AppModule, which imports it.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runReadinessProbe().catch(() => {
    process.stdout.write(
      JSON.stringify({ service: 'catalog-svc', status: 'not_ready' }) + '\n',
    );
    process.exitCode = 1;
  });
}
