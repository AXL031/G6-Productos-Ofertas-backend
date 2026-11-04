#!/usr/bin/env node
/**
 * Aprovisiona PostgreSQL efímero bajo control del harness y ejecuta las pruebas
 * de integración de taxonomy. Nunca acepta una URL externa como destino de DDL.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const MINIMO_PRUEBAS = 21;
const ESPEC = 'apps/taxonomy-svc/test/persistencia-drizzle.e2e-spec.ts';
const HARNESS_VARIABLE = 'TAXONOMY_TEST_HARNESS_ID';
const ACK_VARIABLE = 'TAXONOMY_TEST_DB_ACK';
const EPHEMERAL_VARIABLE = 'TAXONOMY_TEST_DB_EPHEMERAL';
const DATABASE_URL_VARIABLE = 'TAXONOMY_TEST_DATABASE_URL';
const HARNESS_LABEL = 'com.taller-sw.g6.taxonomy-harness';
const HARNESS_ID_LABEL = 'com.taller-sw.g6.taxonomy-harness-id';
const MAXIMO_LOGS = 80;
const MAXIMO_CARACTERES_DIAGNOSTICO = 12_000;

let faseActual = 'iniciar';
let valoresSecretos = [];

function fallar(mensaje) {
  throw new Error(mensaje);
}

export function argumentosPgIsReady(nombre) {
  return [
    'exec',
    nombre,
    'pg_isready',
    '-h',
    '127.0.0.1',
    '-U',
    'postgres',
    '-d',
    'taxonomy_test',
  ];
}

export function sanitizarDiagnostico(texto, secretos = valoresSecretos) {
  let seguro = String(texto ?? '');
  for (const secreto of secretos) {
    if (secreto) seguro = seguro.replaceAll(secreto, '[redactado]');
  }
  return seguro
    .replace(/(postgres(?:ql)?:\/\/)[^\s/@]+@/gi, '$1[redactado]@')
    .slice(0, MAXIMO_CARACTERES_DIAGNOSTICO);
}

export function publicarSalidaVitest(
  stdout,
  stderr,
  secretos = valoresSecretos,
  consola = console,
) {
  const salida = sanitizarDiagnostico(stdout, secretos);
  const error = sanitizarDiagnostico(stderr, secretos);
  if (salida) consola.log(salida);
  if (error) consola.error(error);
}

export function intentarLanzamiento(estado, lanzar) {
  estado.lanzamientoIntentado = true;
  return lanzar();
}

export function acreditarPropiedadContenedor(
  nombre,
  harnessId,
  ejecutarProceso = spawnSync,
) {
  let inspeccion;
  try {
    inspeccion = ejecutarProceso(
      'docker',
      [
        'inspect',
        '--type',
        'container',
        '--format',
        '{{.Id}}|{{json .Config.Labels}}',
        nombre,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
    );
  } catch (error) {
    return {
      ok: false,
      ausente: false,
      mensaje: `no se pudo inspeccionar la propiedad del contenedor: ${sanitizarDiagnostico(error instanceof Error ? error.message : String(error))}`,
    };
  }

  if (inspeccion.error) {
    return {
      ok: false,
      ausente: false,
      mensaje: `no se pudo inspeccionar la propiedad del contenedor: ${sanitizarDiagnostico(inspeccion.error.message)}`,
    };
  }
  if (inspeccion.status !== 0) {
    const salida = (inspeccion.stderr ?? '').trim();
    const ausente =
      inspeccion.status === 1 &&
      [
        `No such container: ${nombre}`,
        `Error response from daemon: No such container: ${nombre}`,
        `No such object: ${nombre}`,
        `Error: No such object: ${nombre}`,
      ].includes(salida);
    return ausente
      ? { ok: false, ausente: true }
      : {
          ok: false,
          ausente: false,
          mensaje: `no se pudo inspeccionar la propiedad del contenedor: ${sanitizarDiagnostico((inspeccion.stderr || `docker inspect terminó con código ${inspeccion.status}.`).trim())}`,
        };
  }

  const separador = (inspeccion.stdout ?? '').indexOf('|');
  if (separador <= 0) {
    return {
      ok: false,
      ausente: false,
      mensaje: 'Docker devolvió una identidad de contenedor no interpretable.',
    };
  }
  const containerId = inspeccion.stdout.slice(0, separador).trim();
  let etiquetas;
  try {
    etiquetas = JSON.parse(inspeccion.stdout.slice(separador + 1));
  } catch {
    return {
      ok: false,
      ausente: false,
      mensaje: 'Docker devolvió etiquetas no interpretables.',
    };
  }
  if (
    !containerId ||
    etiquetas?.[HARNESS_LABEL] !== 'true' ||
    etiquetas?.[HARNESS_ID_LABEL] !== harnessId
  ) {
    return {
      ok: false,
      ausente: false,
      mensaje:
        'el contenedor existe, pero no acredita pertenecer a esta ejecución del harness.',
    };
  }
  return { ok: true, ausente: false, containerId };
}

export function eliminarContenedor(
  nombre,
  harnessId,
  ejecutarProceso = spawnSync,
  propiedad = acreditarPropiedadContenedor(nombre, harnessId, ejecutarProceso),
) {
  if (!propiedad.ok) {
    return propiedad.ausente
      ? { ok: true }
      : { ok: false, mensaje: propiedad.mensaje };
  }

  let eliminacion;
  try {
    eliminacion = ejecutarProceso(
      'docker',
      ['rm', '--force', propiedad.containerId],
      {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    );
  } catch (error) {
    return {
      ok: false,
      mensaje: `falló la eliminación del contenedor propio: ${sanitizarDiagnostico(error instanceof Error ? error.message : String(error))}`,
    };
  }
  if (eliminacion.error) {
    return {
      ok: false,
      mensaje: `falló la eliminación del contenedor propio: ${sanitizarDiagnostico(eliminacion.error.message)}`,
    };
  }
  if (eliminacion.status !== 0) {
    return {
      ok: false,
      mensaje: `docker rm terminó con código ${eliminacion.status}: ${sanitizarDiagnostico((eliminacion.stderr || eliminacion.stdout || '').trim())}`,
    };
  }

  let verificacion;
  try {
    verificacion = acreditarPropiedadContenedor(
      nombre,
      harnessId,
      ejecutarProceso,
    );
  } catch (error) {
    return {
      ok: false,
      mensaje: `no se pudo verificar la eliminación del contenedor: ${sanitizarDiagnostico(error instanceof Error ? error.message : String(error))}`,
    };
  }
  if (verificacion.ausente) {
    return { ok: true };
  }
  return {
    ok: false,
    mensaje: verificacion.ok
      ? 'el contenedor sigue presente después de docker rm.'
      : (verificacion.mensaje ?? 'no se confirmó la ausencia del contenedor.'),
  };
}

export function finalizarHarness({
  nombreContenedor,
  harnessId,
  lanzamientoIntentado,
  falloOriginal,
  directorio,
  diagnosticar = diagnosticarContenedor,
  eliminar = eliminarContenedor,
  acreditar = acreditarPropiedadContenedor,
  limpiarTemporal = (ruta) => rmSync(ruta, { recursive: true, force: true }),
  advertir = (mensaje) =>
    console.error(`[taxonomy-integration] WARN: ${mensaje}`),
  informarExito = () => undefined,
}) {
  const advertencias = [];
  const propiedad = lanzamientoIntentado
    ? acreditar(nombreContenedor, harnessId)
    : undefined;
  if (falloOriginal && lanzamientoIntentado) {
    try {
      diagnosticar(nombreContenedor, harnessId, propiedad);
    } catch (error) {
      advertencias.push(
        `falló el diagnóstico: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (lanzamientoIntentado) {
    try {
      const resultado = eliminar(
        nombreContenedor,
        harnessId,
        spawnSync,
        propiedad,
      );
      if (!resultado?.ok) {
        advertencias.push(
          resultado?.mensaje ?? 'no se confirmó la eliminación del contenedor.',
        );
      }
    } catch (error) {
      advertencias.push(
        `falló la limpieza del contenedor: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (directorio) {
    try {
      limpiarTemporal(directorio);
    } catch (error) {
      advertencias.push(
        `falló la limpieza del directorio temporal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const advertencia of advertencias) {
    try {
      advertir(sanitizarDiagnostico(advertencia));
    } catch {
      // La escritura de una advertencia tampoco debe alterar el resultado original.
    }
  }

  if (falloOriginal) throw falloOriginal;
  if (advertencias.length > 0) {
    throw new Error('La limpieza del harness no se completó correctamente.');
  }
  informarExito();
}

function ejecutarDocker(argumentos, opciones = {}) {
  const resultado = spawnSync('docker', argumentos, {
    encoding: 'utf8',
    timeout: opciones.timeout ?? 180_000,
    windowsHide: true,
  });
  if (resultado.error) {
    fallar(
      `no se pudo ejecutar Docker (${sanitizarDiagnostico(resultado.error.message)}).`,
    );
  }
  if (resultado.status !== 0) {
    fallar(
      `Docker ${argumentos[0]} terminó con código ${resultado.status}: ${sanitizarDiagnostico((resultado.stderr || resultado.stdout || '').trim())}`,
    );
  }
  return resultado.stdout.trim();
}

function validarEntorno() {
  if (process.env[DATABASE_URL_VARIABLE]?.trim()) {
    fallar(
      `${DATABASE_URL_VARIABLE} está prohibida: el harness genera la URL de su propio contenedor y no acepta destinos externos.`,
    );
  }
}

export async function esperarPostgres(
  nombre,
  {
    ejecutarProceso = spawnSync,
    ahora = Date.now,
    pausar = (ms) => new Promise((resolver) => setTimeout(resolver, ms)),
  } = {},
) {
  const deadline = ahora() + 60_000;
  while (true) {
    const restante = deadline - ahora();
    if (restante <= 0) break;
    const resultado = ejecutarProceso('docker', argumentosPgIsReady(nombre), {
      encoding: 'utf8',
      timeout: Math.min(5_000, restante),
      windowsHide: true,
    });
    if (resultado.status === 0) return;
    const restanteTrasIntento = deadline - ahora();
    if (restanteTrasIntento <= 0) break;
    await pausar(Math.min(1_000, restanteTrasIntento));
  }
  fallar('PostgreSQL del harness no quedó listo dentro de 60 segundos.');
}

export function diagnosticarContenedor(
  nombre,
  harnessId,
  propiedad = acreditarPropiedadContenedor(nombre, harnessId),
  ejecutarProceso = spawnSync,
  consola = console,
) {
  if (!propiedad?.ok) {
    consola.error(
      `[taxonomy-integration] Diagnóstico omitido: el contenedor ${propiedad?.ausente ? 'no existe' : 'no acredita propiedad'}; no se leyeron estado ni logs.`,
    );
    return;
  }

  consola.error(
    `[taxonomy-integration] Diagnóstico acotado; fase=${faseActual}.`,
  );
  const estado = ejecutarProceso(
    'docker',
    [
      'inspect',
      '--type',
      'container',
      '--format',
      '{{json .State}}',
      propiedad.containerId,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (estado.status === 0) {
    try {
      const datos = JSON.parse(estado.stdout);
      consola.error(
        `[taxonomy-integration] contenedor status=${datos.Status ?? 'desconocido'} exit_code=${datos.ExitCode ?? 'desconocido'} oom_killed=${datos.OOMKilled ?? 'desconocido'}.`,
      );
    } catch {
      consola.error(
        '[taxonomy-integration] estado del contenedor no interpretable.',
      );
    }
  } else {
    consola.error(
      `[taxonomy-integration] estado del contenedor no disponible (puede haberse eliminado automáticamente); docker inspect status=${estado.status ?? 'desconocido'}.`,
    );
  }

  const logs = ejecutarProceso(
    'docker',
    ['logs', '--tail', String(MAXIMO_LOGS), propiedad.containerId],
    {
      encoding: 'utf8',
      maxBuffer: 512 * 1024,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (logs.status === 0) {
    const contenido = sanitizarDiagnostico(
      `${logs.stdout ?? ''}${logs.stderr ?? ''}`,
    );
    consola.error(
      `[taxonomy-integration] últimos ${MAXIMO_LOGS} logs (máximo ${MAXIMO_CARACTERES_DIAGNOSTICO} caracteres):\n${contenido || '(sin logs)'}`,
    );
  } else {
    consola.error(
      `[taxonomy-integration] logs no disponibles (puede haberse eliminado automáticamente); docker logs status=${logs.status ?? 'desconocido'}.`,
    );
  }
}

async function comprobarIdentidad(url, harnessId) {
  const cliente = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  try {
    await cliente.connect();
    const resultado = await cliente.query(
      "SELECT current_setting('g6.taxonomy_harness_id', true) AS harness_id",
    );
    if (resultado.rows[0]?.harness_id !== harnessId) {
      fallar('el servidor PostgreSQL no acredita la identidad del harness.');
    }
  } finally {
    await cliente.end().catch(() => undefined);
  }
}

async function ejecutar() {
  faseActual = 'validar-entorno';
  validarEntorno();
  faseActual = 'comprobar-docker';
  ejecutarDocker(['info'], { timeout: 10_000 });

  const harnessId = randomBytes(32).toString('hex');
  const nombreContenedor = `g6-taxonomy-${randomUUID().slice(0, 18)}`;
  const password = randomBytes(24).toString('hex');
  valoresSecretos = [harnessId, password];
  let directorio;
  const estado = { lanzamientoIntentado: false };
  let falloOriginal;
  let mensajeExito;

  try {
    faseActual = 'crear-postgres';
    intentarLanzamiento(estado, () =>
      ejecutarDocker([
        'run',
        '--detach',
        '--rm',
        '--name',
        nombreContenedor,
        '--label',
        `${HARNESS_LABEL}=true`,
        '--label',
        `${HARNESS_ID_LABEL}=${harnessId}`,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        `POSTGRES_PASSWORD=${password}`,
        '--env',
        'POSTGRES_DB=taxonomy_test',
        'postgres:17-alpine',
        'postgres',
        '-c',
        `g6.taxonomy_harness_id=${harnessId}`,
      ]),
    );

    faseActual = 'esperar-postgres-tcp';
    await esperarPostgres(nombreContenedor);
    faseActual = 'obtener-puerto-loopback';
    const puertoPublicado = ejecutarDocker([
      'port',
      nombreContenedor,
      '5432/tcp',
    ]);
    const coincidenciaPuerto = /^127\.0\.0\.1:(\d+)$/.exec(puertoPublicado);
    if (!coincidenciaPuerto) {
      fallar(
        `Docker publicó PostgreSQL fuera del loopback esperado (${puertoPublicado}).`,
      );
    }

    const url = `postgresql://postgres:${password}@127.0.0.1:${coincidenciaPuerto[1]}/taxonomy_test`;
    faseActual = 'comprobar-identidad';
    await comprobarIdentidad(url, harnessId);

    faseActual = 'ejecutar-vitest';
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('vitest/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const relBin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vitest;
    if (!relBin) fallar('no se pudo ubicar el binario de vitest.');
    const vitest = join(dirname(pkgPath), relBin);

    directorio = mkdtempSync(join(tmpdir(), 'g6-taxonomy-'));
    const salida = join(directorio, 'vitest.json');
    const resultado = spawnSync(
      process.execPath,
      [
        vitest,
        'run',
        '--config',
        './vitest.config.e2e.ts',
        ESPEC,
        '--reporter=json',
        `--outputFile=${salida}`,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 180_000,
        env: {
          ...process.env,
          [DATABASE_URL_VARIABLE]: url,
          [ACK_VARIABLE]: 'desechable-aislado',
          [EPHEMERAL_VARIABLE]: '1',
          [HARNESS_VARIABLE]: harnessId,
        },
      },
    );
    publicarSalidaVitest(resultado.stdout, resultado.stderr);
    if (resultado.error) {
      fallar(
        `vitest no pudo completarse (${sanitizarDiagnostico(resultado.error.message)}).`,
      );
    }

    if (!existsSync(salida)) {
      fallar(
        `vitest no generó el reporte JSON (código ${resultado.status ?? 'desconocido'}).`,
      );
    }

    const reporte = JSON.parse(readFileSync(salida, 'utf8'));
    const total = reporte.numTotalTests ?? 0;
    const superadas = reporte.numPassedTests ?? 0;
    const omitidas = reporte.numPendingTests ?? 0;
    const fallidas = reporte.numFailedTests ?? 0;

    if (fallidas > 0) {
      const detalles = (reporte.testResults ?? [])
        .flatMap((archivo) =>
          (archivo.assertionResults ?? [])
            .filter((prueba) => prueba.status === 'failed')
            .map((prueba) => {
              const mensaje = (prueba.failureMessages ?? []).join(' ');
              return `${archivo.name}: ${prueba.fullName ?? prueba.title}: ${mensaje}`;
            }),
        )
        .join('\n')
        .slice(0, MAXIMO_CARACTERES_DIAGNOSTICO);
      fallar(
        `${fallidas} prueba(s) fallaron.${detalles ? `\n${sanitizarDiagnostico(detalles)}` : ''}`,
      );
    }
    if ((resultado.status ?? 1) !== 0) {
      fallar(`vitest terminó con código ${resultado.status}.`);
    }
    if (omitidas > 0) {
      fallar(
        `${omitidas} prueba(s) omitidas: las pruebas de integración no pueden saltarse.`,
      );
    }
    if (total === 0) fallar('no se recolectó ninguna prueba.');
    if (superadas < MINIMO_PRUEBAS) {
      fallar(
        `solo ${superadas} prueba(s) superadas; se esperaban al menos ${MINIMO_PRUEBAS}.`,
      );
    }

    mensajeExito = `[taxonomy-integration] PASS: ${superadas}/${total} pruebas superadas, 0 omitidas, 0 fallidas; PostgreSQL ${nombreContenedor} aprovisionado por el harness.`;
  } catch (error) {
    falloOriginal = error;
  } finally {
    finalizarHarness({
      nombreContenedor,
      harnessId,
      lanzamientoIntentado: estado.lanzamientoIntentado,
      falloOriginal,
      directorio,
      diagnosticar: diagnosticarContenedor,
      eliminar: eliminarContenedor,
      limpiarTemporal: (ruta) => rmSync(ruta, { recursive: true, force: true }),
      informarExito: () => console.log(mensajeExito),
    });
  }
}

const ejecucionDirecta =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (ejecucionDirecta) {
  ejecutar().catch((error) => {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error(
      `[taxonomy-integration] FAIL fase=${faseActual}: ${sanitizarDiagnostico(mensaje)}`,
    );
    process.exitCode = 1;
  });
}
