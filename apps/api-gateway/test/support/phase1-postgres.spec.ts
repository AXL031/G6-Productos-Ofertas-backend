import {
  argumentosReadinessPhase1,
  clasificarLogsInicioPostgres,
} from './phase1-postgres.js';

describe('readiness de PostgreSQL Phase 1', () => {
  it('exige el puerto TCP loopback y no acepta readiness solo por socket Unix', () => {
    expect(argumentosReadinessPhase1('g6-phase1-test')).toEqual([
      'exec',
      'g6-phase1-test',
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-p',
      '5432',
      '-U',
      'postgres',
    ]);
  });

  it.each([
    [
      'initdb falla',
      'initdb: error: could not create directory',
      'initdb_failed',
    ],
    [
      'servidor temporal detenido y servidor definitivo pendiente',
      'database system is shut down\nPostgreSQL init process complete; ready for start up.',
      'init_complete_final_server_pending',
    ],
    [
      'interrupción durante recuperación',
      'LOG: database system was interrupted; last known up at 2026-11-05 20:00:00 UTC',
      'recovery_after_interruption',
    ],
    [
      'servidor informa readiness',
      'LOG: database system is ready to accept connections',
      'postgres_ready_marker',
    ],
  ] as const)(
    'clasifica logs de startup sin publicarlos: %s',
    (_name, logs, phase) => {
      expect(clasificarLogsInicioPostgres(logs)).toBe(phase);
    },
  );

  it('devuelve solo una categoría cuando los logs contienen texto sensible', () => {
    const result = clasificarLogsInicioPostgres(
      'POSTGRES_PASSWORD=fixture-secret\ninitdb: error: invalid password',
    );

    expect(result).toBe('initdb_failed');
    expect(result).not.toContain('fixture-secret');
  });
});
