import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  argumentosPgIsReady,
  acreditarPropiedadContenedor,
  diagnosticarContenedor,
  eliminarContenedor,
  finalizarHarness,
  intentarLanzamiento,
  publicarSalidaVitest,
  sanitizarDiagnostico,
  esperarPostgres,
} from './run-taxonomy-integration.mjs';

const runner = fileURLToPath(
  new URL('./run-taxonomy-integration.mjs', import.meta.url),
);

test('PostgreSQL readiness probes TCP instead of accepting the Unix socket', () => {
  assert.deepEqual(argumentosPgIsReady('g6-taxonomy-test'), [
    'exec',
    'g6-taxonomy-test',
    'pg_isready',
    '-h',
    '127.0.0.1',
    '-U',
    'postgres',
    '-d',
    'taxonomy_test',
  ]);
});

test('PostgreSQL readiness uses bounded per-probe timeouts and a 60 second deadline', async () => {
  let reloj = 0;
  const timeouts = [];
  await assert.rejects(
    esperarPostgres('g6-taxonomy-test', {
      ahora: () => reloj,
      ejecutarProceso: (_comando, argumentos, opciones) => {
        assert.deepEqual(argumentos, argumentosPgIsReady('g6-taxonomy-test'));
        timeouts.push(opciones.timeout);
        reloj += opciones.timeout;
        return { status: 1 };
      },
      pausar: async (ms) => {
        reloj += ms;
      },
    }),
    /60 segundos/,
  );
  assert.ok(timeouts.length > 0);
  assert.ok(timeouts.every((timeout) => timeout > 0 && timeout <= 5_000));
  assert.equal(reloj, 60_000);
});

test('diagnostics redact generated passwords, harness IDs, and PostgreSQL URL credentials', () => {
  const password = 'generated-password-secret';
  const harnessId = 'random-harness-identity';
  const detalle = sanitizarDiagnostico(
    `dsn=postgresql://postgres:${password}@127.0.0.1/db id=${harnessId} docker=${password}`,
    [password, harnessId],
  );

  assert.doesNotMatch(detalle, new RegExp(`${password}|${harnessId}`));
  assert.match(detalle, /postgresql:\/\/\[redactado\]@/);
});

test('Vitest stdout and stderr are sanitized before being emitted', () => {
  const password = 'vitest-password-secret';
  const harnessId = 'vitest-harness-identity';
  const emitidos = [];
  const consola = {
    log: (texto) => emitidos.push(texto),
    error: (texto) => emitidos.push(texto),
  };

  publicarSalidaVitest(
    `stdout ${password} postgresql://postgres:${password}@localhost/db`,
    `stderr ${harnessId}`,
    [password, harnessId],
    consola,
  );

  assert.equal(emitidos.length, 2);
  assert.doesNotMatch(
    emitidos.join('\n'),
    /vitest-password-secret|vitest-harness-identity/,
  );
  assert.match(emitidos[0], /\[redactado\]/);
});

test('rejects caller-supplied database URL before Docker provisioning', () => {
  const resultado = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TAXONOMY_TEST_DATABASE_URL:
        'postgresql://runner:secret@127.0.0.1:5432/shared',
    },
    windowsHide: true,
  });

  assert.equal(resultado.status, 1);
  assert.match(resultado.stderr, /TAXONOMY_TEST_DATABASE_URL está prohibida/);
  assert.doesNotMatch(resultado.stderr, /Docker run/);
});

test('a failed Docker launch is recorded first and cleans only its generated name', () => {
  const estado = { lanzamientoIntentado: false };
  const errorOriginal = new Error('docker run failed');
  const eliminados = [];

  assert.throws(
    () =>
      intentarLanzamiento(estado, () => {
        assert.equal(estado.lanzamientoIntentado, true);
        throw errorOriginal;
      }),
    (error) => error === errorOriginal,
  );
  assert.throws(
    () =>
      finalizarHarness({
        nombreContenedor: 'g6-taxonomy-random-owned',
        harnessId: 'unique-harness-id',
        lanzamientoIntentado: estado.lanzamientoIntentado,
        falloOriginal: errorOriginal,
        acreditar: () => ({ ok: false, ausente: true }),
        diagnosticar: () => undefined,
        eliminar: (nombre) => {
          eliminados.push(nombre);
          return { ok: true };
        },
      }),
    (error) => error === errorOriginal,
  );

  assert.deepEqual(eliminados, ['g6-taxonomy-random-owned']);
});

test('diagnostic failure does not prevent container removal or replace original error', () => {
  const original = new Error('readiness failed');
  const eventos = [];

  assert.throws(
    () =>
      finalizarHarness({
        nombreContenedor: 'g6-taxonomy-random-owned',
        lanzamientoIntentado: true,
        falloOriginal: original,
        acreditar: () => ({ ok: false, ausente: true }),
        diagnosticar: () => {
          eventos.push('diagnostic');
          throw new Error('diagnostic failed');
        },
        eliminar: () => {
          eventos.push('remove');
          return { ok: true };
        },
        advertir: (mensaje) => eventos.push(`warning:${mensaje}`),
      }),
    (error) => error === original,
  );

  assert.equal(eventos[0], 'diagnostic');
  assert.ok(eventos.includes('remove'));
});

test('container ownership is inspected before removal and only the matching run can remove it', () => {
  const nombre = 'g6-taxonomy-owned';
  const harnessId = 'unique-harness-id';
  const etiquetasPropias = JSON.stringify({
    'com.taller-sw.g6.taxonomy-harness': 'true',
    'com.taller-sw.g6.taxonomy-harness-id': harnessId,
  });
  const secuencia = (
    primeraInspeccion,
    posterior = {
      status: 1,
      stdout: '',
      stderr: `Error response from daemon: No such container: ${nombre}\n`,
    },
  ) => {
    const comandos = [];
    let inspecciones = 0;
    const resultado = eliminarContenedor(
      nombre,
      harnessId,
      (_binario, args) => {
        comandos.push(args);
        if (args[0] === 'rm') {
          return { status: 0, stdout: 'removed-container-id', stderr: '' };
        }
        inspecciones += 1;
        if (inspecciones !== 1) return posterior;
        if (primeraInspeccion.status !== 0) return primeraInspeccion;
        const [id, labels] = primeraInspeccion.stdout.split('|');
        return { ...primeraInspeccion, stdout: `${id}|${labels}` };
      },
    );
    return { comandos, resultado };
  };

  const propio = secuencia({
    status: 0,
    stdout: `immutable-container-id|${etiquetasPropias}`,
    stderr: '',
  });
  assert.deepEqual(
    propio.comandos.map((args) => args[0]),
    ['inspect', 'rm', 'inspect'],
  );
  assert.deepEqual(propio.comandos[1], [
    'rm',
    '--force',
    'immutable-container-id',
  ]);
  assert.deepEqual(propio.resultado, { ok: true });

  const ajeno = secuencia({
    status: 0,
    stdout: `foreign-container-id|${JSON.stringify({
      'com.taller-sw.g6.taxonomy-harness': 'true',
      'com.taller-sw.g6.taxonomy-harness-id': 'different-harness-id',
    })}`,
    stderr: '',
  });
  assert.deepEqual(
    ajeno.comandos.map((args) => args[0]),
    ['inspect'],
  );
  assert.equal(ajeno.resultado.ok, false);

  const inexistente = secuencia({
    status: 1,
    stdout: '',
    stderr: `Error response from daemon: No such container: ${nombre}\n`,
  });
  assert.deepEqual(
    inexistente.comandos.map((args) => args[0]),
    ['inspect'],
  );
  assert.deepEqual(inexistente.resultado, { ok: true });

  const inspeccionFallida = secuencia({
    status: 1,
    stdout: '',
    stderr: 'Cannot connect to the Docker daemon.',
  });
  assert.deepEqual(
    inspeccionFallida.comandos.map((args) => args[0]),
    ['inspect'],
  );
  assert.equal(inspeccionFallida.resultado.ok, false);
});

test('name collision with a foreign container preserves the run error and reads neither its state nor logs', () => {
  const nombre = 'g6-taxonomy-collision';
  const harnessId = 'current-run-id';
  const comandos = [];
  const executor = (_binario, args) => {
    comandos.push(args);
    return {
      status: 0,
      stdout: `foreign-container-id|${JSON.stringify({
        'com.taller-sw.g6.taxonomy-harness': 'true',
        'com.taller-sw.g6.taxonomy-harness-id': 'other-run-id',
      })}`,
      stderr: '',
    };
  };
  const errorOriginal = new Error('docker run name collision');
  const salidaDiagnostico = [];

  assert.throws(
    () =>
      finalizarHarness({
        nombreContenedor: nombre,
        harnessId,
        lanzamientoIntentado: true,
        falloOriginal: errorOriginal,
        acreditar: (containerName, runId) =>
          acreditarPropiedadContenedor(containerName, runId, executor),
        diagnosticar: (containerName, runId, propiedad) =>
          diagnosticarContenedor(containerName, runId, propiedad, executor, {
            error: (mensaje) => salidaDiagnostico.push(mensaje),
          }),
        eliminar: (containerName, runId, _spawn, propiedad) =>
          eliminarContenedor(containerName, runId, executor, propiedad),
        advertir: () => undefined,
      }),
    (error) => error === errorOriginal,
  );

  assert.deepEqual(
    comandos.map((args) => args[0]),
    ['inspect'],
  );
  assert.match(salidaDiagnostico[0], /no acredita propiedad/);
});

test('missing container and inconclusive inspection skip state and logs while preserving the run error', () => {
  for (const [caso, salidaInspeccion] of [
    [
      'missing',
      {
        status: 1,
        stderr:
          'Error response from daemon: No such container: g6-taxonomy-case\n',
      },
    ],
    [
      'inspection-error',
      { status: 1, stderr: 'Cannot connect to the Docker daemon.' },
    ],
  ]) {
    const comandos = [];
    const executor = (_binario, args) => {
      comandos.push(args);
      return salidaInspeccion;
    };
    const original = new Error(`docker run failed: ${caso}`);
    assert.throws(
      () =>
        finalizarHarness({
          nombreContenedor: 'g6-taxonomy-case',
          harnessId: 'current-run-id',
          lanzamientoIntentado: true,
          falloOriginal: original,
          acreditar: (nombre, id) =>
            acreditarPropiedadContenedor(nombre, id, executor),
          diagnosticar: (nombre, id, propiedad) =>
            diagnosticarContenedor(nombre, id, propiedad, executor, {
              error: () => undefined,
            }),
          eliminar: (nombre, id, _spawn, propiedad) =>
            eliminarContenedor(nombre, id, executor, propiedad),
          advertir: () => undefined,
        }),
      (error) => error === original,
    );
    assert.deepEqual(
      comandos.map((args) => args[0]),
      ['inspect'],
    );
  }
});

test('cleanup verification failure never reports PASS', () => {
  let pases = 0;
  let advertencias = 0;
  assert.throws(
    () =>
      finalizarHarness({
        nombreContenedor: 'g6-taxonomy-owned',
        harnessId: 'unique-harness-id',
        lanzamientoIntentado: true,
        acreditar: () => ({ ok: false, ausente: true }),
        eliminar: () => ({ ok: false, mensaje: 'rm failed' }),
        advertir: () => {
          advertencias += 1;
        },
        informarExito: () => {
          pases += 1;
        },
      }),
    /limpieza del harness/,
  );
  assert.equal(advertencias, 1);
  assert.equal(pases, 0);
});
