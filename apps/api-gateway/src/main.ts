import { NestFactory } from '@nestjs/core';
import { ApiGatewayModule } from './api-gateway.module.js';
import { configureGatewayCors } from './routing/gateway-cors.js';
import {
  readGatewayEnvironment,
  readGatewayPort,
} from './routing/gateway-settings.js';

async function bootstrap() {
  const env = readGatewayEnvironment();
  const port = readGatewayPort(env);
  const app = await NestFactory.create(ApiGatewayModule, {
    bodyParser: false,
    logger: false,
    abortOnError: false,
  });
  configureGatewayCors(app, env.GATEWAY_CORS_ALLOWED_ORIGINS);
  app.enableShutdownHooks();
  await app.listen(port);
  process.stdout.write(
    JSON.stringify({ service: 'api-gateway', code: 'APPLICATION_STARTED' }) +
      '\n',
  );
}
await bootstrap().catch(() => {
  process.stderr.write(
    JSON.stringify({
      service: 'api-gateway',
      code: 'APPLICATION_START_FAILED',
    }) + '\n',
  );
  process.exitCode = 1;
});
