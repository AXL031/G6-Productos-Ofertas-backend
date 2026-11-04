import { NestFactory } from '@nestjs/core';
import { createApplication, startPricing } from './bootstrap.js';

vi.mock('node:fs', () => ({ existsSync: () => false }));

describe('Pricing bootstrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = 0;
  });

  it('rechaza configuración inválida antes de crear Nest o abrir puertos', async () => {
    const create = vi.spyOn(NestFactory, 'create');
    await expect(
      createApplication({ NODE_ENV: 'test', PRICING_SVC_PORT: '3002' }),
    ).rejects.toThrow('DATABASE_URL');
    expect(create).not.toHaveBeenCalled();
  });
  it('rechaza demo production no confirmada antes de crear Nest o abrir puertos', async () => {
    const create = vi.spyOn(NestFactory, 'create');
    await expect(
      createApplication({
        NODE_ENV: 'production',
        PRICING_SVC_PORT: '3002',
        DATABASE_URL:
          'postgresql://pricing:fixture@localhost/fixture?sslmode=verify-full',
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'true',
      }),
    ).rejects.toThrow('PRICING_DEMO_PRODUCTION_CONFIRMED=true');
    expect(create).not.toHaveBeenCalled();
  });

  it('falla el arranque con código 1 y logs JSON sin el valor inválido', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PRICING_SVC_PORT', 'fixture-sensitive-value');
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await startPricing();
    expect(process.exitCode).toBe(1);
    const logs = output.mock.calls.map(([value]) => String(value)).join('');
    expect(logs).not.toContain('fixture-sensitive-value');
    expect(logs).toContain('PRICING_SVC_PORT');
    expect(JSON.parse(logs).message.service).toBe('pricing-svc');
  });

  it('impide arrancar producción sin TLS sin escribir el secreto arbitrario de la URL', async () => {
    const secret = 'a8Q3z9V6m2K5r7X1';
    const env = {
      NODE_ENV: 'production',
      PRICING_SVC_PORT: '3002',
      DATABASE_URL: `postgresql://pricing:${secret}@localhost/fixture?sslmode=disable`,
    };
    const create = vi.spyOn(NestFactory, 'create');
    await expect(createApplication(env)).rejects.toThrow('sslmode=verify-full');
    expect(create).not.toHaveBeenCalled();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await startPricing();
    expect(process.exitCode).toBe(1);
    const output = [...stdout.mock.calls, ...stderr.mock.calls]
      .map(([value]) => String(value))
      .join('');
    expect(output).not.toContain(secret);
    expect(output).toContain('DATABASE_URL/TLS');
  });
});
