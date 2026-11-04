import { SafeLogger } from './safe-logger.js';

describe('SafeLogger', () => {
  it('registra duración/estado/correlación con límites y sin contenido externo', () => {
    const sink = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const logger = new SafeLogger('test', sink);
    logger.http('fixture-sensitive-token', NaN, Infinity);
    expect(sink.log).toHaveBeenLastCalledWith({
      service: 'price-audit-svc',
      environment: 'test',
      message: 'Consulta HTTP de Audit finalizada.',
      correlation_id: '[REDACTED]',
      status: 500,
      duration_ms: 0,
    });
    logger.http('74ed2f19-7e70-4915-a6f6-bbc691b82587', 200, 12.4);
    expect(sink.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 200,
        duration_ms: 12,
        correlation_id: '74ed2f19-7e70-4915-a6f6-bbc691b82587',
      }),
    );
    expect(JSON.stringify(sink.log.mock.calls)).not.toContain(
      'fixture-sensitive-token',
    );
  });
  it.each(['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const)(
    'omite secretos y objetos también en los argumentos de %s',
    (level) => {
      const sink = {
        log: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        verbose: vi.fn(),
        fatal: vi.fn(),
      };
      const logger = new SafeLogger('test', sink);
      const secret = 'fixture-sensitive-value';
      const cycle: Record<string, unknown> = { password: secret };
      cycle.self = cycle;
      for (const value of [
        `postgresql://user:${secret}@host/db`,
        `Bearer ${secret}`,
        `client_secret=${secret}`,
        `password=${secret}`,
        'eyJhbGciOiJIUzI1NiJ9.fixture.signature',
        { authorization: secret },
        new Error(secret),
        cycle,
      ])
        logger[level](value, value);
      const output = JSON.stringify(sink[level].mock.calls);
      expect(output).not.toContain(secret);
      expect(output).not.toContain('eyJhbGci');
      expect(output).toContain('[REDACTED]');
      logger[level]('price-audit-svc iniciado.', 'Bootstrap');
      expect(sink[level]).toHaveBeenLastCalledWith({
        service: 'price-audit-svc',
        environment: 'test',
        message: 'price-audit-svc iniciado.',
        context: ['Bootstrap'],
      });
    },
  );

  it('nunca escribe secretos arbitrarios sin etiquetas en stdout/stderr', () => {
    const secret = 'q7Zx4vM2n8Lb5cR9';
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const logger = new SafeLogger(secret);
      for (const level of [
        'log',
        'error',
        'warn',
        'debug',
        'verbose',
        'fatal',
      ] as const) {
        for (const value of [
          secret,
          `falló: ${secret}`,
          { value: secret },
          new Error(secret),
        ])
          logger[level](value, secret);
        logger[level]('price-audit-svc iniciado.', secret);
      }
      const output = [...stdout.mock.calls, ...stderr.mock.calls]
        .map(([value]) => String(value))
        .join('');
      expect(stdout).toHaveBeenCalled();
      expect(stderr).toHaveBeenCalled();
      expect(output).not.toContain(secret);
      for (const line of output.trim().split('\n')) {
        const record = JSON.parse(line);
        expect(record).toHaveProperty('timestamp');
        expect(record).toHaveProperty('level');
        expect(record.message).toMatchObject({
          service: 'price-audit-svc',
          environment: '[REDACTED]',
        });
        expect(record.message.context).toEqual(['[REDACTED]']);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});
