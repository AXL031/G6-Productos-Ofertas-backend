import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** Crea y elimina exclusivamente un broker identificado por esta ejecución. */
export class RabbitTaxonomyDesechable {
  readonly name = `g6-taxonomy-audit-${randomBytes(10).toString('hex')}`;
  readonly password = randomBytes(24).toString('hex');
  readonly catalogPassword = randomBytes(24).toString('hex');
  private creado = false;
  private ejecutar(args: string[]): string {
    const r = spawnSync('docker', args, {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    if (r.error || r.status !== 0)
      throw new Error(`Docker ${args[0]} falló en broker desechable`);
    return r.stdout.trim();
  }
  async iniciar(): Promise<{ taxonomyUrl: string; catalogUrl: string }> {
    try {
      this.ejecutar([
        'run',
        '-d',
        '--name',
        this.name,
        '--label',
        'g6.taxonomy.audit=disposable',
        '-p',
        '127.0.0.1::5672',
        '-e',
        'RABBITMQ_DEFAULT_USER=taxonomy_test',
        '-e',
        `RABBITMQ_DEFAULT_PASS=${this.password}`,
        '-e',
        'RABBITMQ_DEFAULT_VHOST=g6-productos-ofertas',
        '-e',
        'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2 +SDcpu 1 +SDio 1',
        '-e',
        'RABBITMQ_CTL_ERL_ARGS=+S 1:1 +SDcpu 1 +SDio 1',
        'rabbitmq:4.2.9-alpine',
      ]);
      this.creado = true;
      let listo = false;
      for (let i = 0; i < 45; i++) {
        try {
          this.ejecutar([
            'exec',
            '--user',
            'rabbitmq',
            this.name,
            'rabbitmq-diagnostics',
            '-q',
            'check_running',
          ]);
          listo = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (!listo) throw new Error('RabbitMQ desechable no arrancó');
      this.ejecutar([
        'exec',
        '--user',
        'rabbitmq',
        this.name,
        'rabbitmqctl',
        'add_user',
        'catalog_test',
        this.catalogPassword,
      ]);
      this.ejecutar([
        'exec',
        '--user',
        'rabbitmq',
        this.name,
        'rabbitmqctl',
        'set_permissions',
        '-p',
        'g6-productos-ofertas',
        'catalog_test',
        '.*',
        '.*',
        '.*',
      ]);
      const puerto = /^127\.0\.0\.1:(\d+)$/.exec(
        this.ejecutar(['port', this.name, '5672/tcp']),
      )?.[1];
      if (!puerto) throw new Error('RabbitMQ no publicado en loopback');
      return {
        taxonomyUrl: `amqp://taxonomy_test:${this.password}@127.0.0.1:${puerto}/g6-productos-ofertas`,
        catalogUrl: `amqp://catalog_test:${this.catalogPassword}@127.0.0.1:${puerto}/g6-productos-ofertas`,
      };
    } catch (error) {
      this.cerrar();
      throw error;
    }
  }
  cerrar(): void {
    if (!this.creado) return;
    this.ejecutar(['rm', '-f', this.name]);
    this.creado = false;
  }
}
