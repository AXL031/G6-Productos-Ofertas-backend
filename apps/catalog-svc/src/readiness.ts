import {
  Controller,
  Get,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { pathToFileURL } from 'node:url';

export const CATALOG_DATABASE = Symbol('CATALOG_DATABASE');

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
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.inFlight = Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Readiness timeout')),
            2000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
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
  let database = 'not_ready';
  let status = 'not_ready';
  let eligibilityStatus = 'unverified';
  let pricingStatus = 'not_checked';
  try {
    await app.get(CommercialReadinessController).checkReadiness((stage) => {
      if (stage === 'database') database = 'ready';
      if (stage === 'catalog-read') {
        if (config.readDemo.enabled) eligibilityStatus = 'not_evaluated_demo';
        else eligibilityStatus = 'not_required_demo';
      }
      if (stage === 'pricing') pricingStatus = 'ready';
      if (stage === 'commercial') eligibilityStatus = 'ready';
    });
    status = 'ready';
  } catch {
    status = 'not_ready';
    if (
      config.marketplaceDemoPreview &&
      database === 'ready' &&
      eligibilityStatus === 'not_required_demo'
    )
      pricingStatus = 'unavailable';
  } finally {
    await app.close();
  }
  process.stdout.write(
    JSON.stringify({
      service: 'catalog-svc',
      status,
      database,
      eligibility: eligibilityStatus,
      ...(config.marketplaceDemoPreview && !config.readDemo.enabled
        ? { pricing: pricingStatus }
        : {}),
    }) + '\n',
  );
  if (status !== 'ready') process.exitCode = 1;
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
