#!/usr/bin/env node
/**
 * Prepara un PostgreSQL 17 TLS de un solo uso y ejecuta el E2E HTTP real
 * Gateway -> Taxonomy -> PostgreSQL. El contenedor y los certificados se
 * identifican y limpian aun cuando Vitest falle.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acreditarPropiedadContenedor,
  eliminarContenedor,
  sanitizarDiagnostico,
} from '../../../scripts/ci/run-taxonomy-integration.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const IMAGE_POSTGRES = 'postgres:17-alpine';
const IMAGE_OPENSSL = 'alpine:3.22';
const LABEL = 'com.taller-sw.g6.taxonomy-harness';
const LABEL_ID = 'com.taller-sw.g6.taxonomy-harness-id';
const MIN_NODE = { major: 24, minor: 15, patch: 0 };

function nodeCompatible(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return (
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 3))) ||
    major > 24 ||
    (major === 24 &&
      (minor > MIN_NODE.minor ||
        (minor === MIN_NODE.minor && patch >= MIN_NODE.patch)))
  );
}

function run(command, args, { phase = command, ...options } = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
    ...options,
  });
  if (result.error) {
    throw new Error(`${phase}: ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = sanitizarDiagnostico(
      (
        result.stderr ||
        result.stdout ||
        `${command} exit ${result.status}`
      ).trim(),
    );
    throw new Error(`${phase}: ${command} falló (${result.status}): ${detail}`);
  }
  return (result.stdout ?? '').trim();
}

function docker(args, phase, timeout = 60_000) {
  return run('docker', args, { phase, timeout });
}

function postgresUrl(port, password, caFile) {
  const url = new URL('postgresql://postgres@127.0.0.1/taxonomy_test');
  url.password = password;
  url.port = String(port);
  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.set('sslrootcert', caFile);
  return url.toString();
}

function pause(ms) {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms));
}

async function main() {
  if (!nodeCompatible(process.versions.node)) {
    throw new Error(
      `Node ${process.versions.node} no satisface package.json (22.22.3 o 24.15.0+).`,
    );
  }

  const sha = run('git', ['rev-parse', 'HEAD'], { phase: 'lectura de SHA' });
  let phase = 'docker info';
  let dockerVersion;
  try {
    dockerVersion = docker(
      ['info', '--format', '{{.ServerVersion}}'],
      phase,
      90_000,
    );
  } catch (error) {
    console.error(
      `[taxonomy-gateway-e2e] evidencia: SHA=${sha}; Node=${process.versions.node}; Docker=indisponible; cleanup=no requerido (sin recursos creados); fallo en fase=${phase}`,
    );
    throw error;
  }
  const harnessId = randomBytes(24).toString('hex');
  const containerName = `g6-taxonomy-gateway-${randomUUID().slice(0, 12)}`;
  const password = randomBytes(24).toString('hex');
  const tempDirectory = mkdtempSync(join(tmpdir(), 'g6-taxonomy-gateway-'));
  const caFile = join(tempDirectory, 'ca.crt');
  const serverCert = join(tempDirectory, 'server.crt');
  const serverKey = join(tempDirectory, 'server.key');
  let launchAttempted = false;
  let failure;
  let cleanupResult = 'no requerido';
  let testSummary = 'sin reporte de pruebas';

  try {
    const mount = `type=bind,source=${tempDirectory},target=/out`;
    const script = [
      'apk add --no-cache openssl >/dev/null',
      'openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 2 -keyout /out/ca.key -out /out/ca.crt -subj "/CN=G6 ephemeral H4 E2E CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"',
      'openssl req -new -newkey rsa:2048 -sha256 -nodes -keyout /out/server.key -out /out/server.csr -subj "/CN=127.0.0.1"',
      "printf '%s\\n' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' 'subjectAltName=IP:127.0.0.1,DNS:localhost' > /out/server.ext",
      'openssl x509 -req -in /out/server.csr -CA /out/ca.crt -CAkey /out/ca.key -CAcreateserial -out /out/server.crt -days 2 -sha256 -extfile /out/server.ext',
      'chmod 600 /out/server.key',
    ].join('; ');
    phase = 'generación de certificados (docker run alpine/OpenSSL)';
    docker(
      ['run', '--rm', '--mount', mount, IMAGE_OPENSSL, 'sh', '-ec', script],
      phase,
      180_000,
    );

    phase = 'inicio de PostgreSQL (docker run)';
    launchAttempted = true;
    docker(
      [
        'run',
        '--detach',
        '--name',
        containerName,
        '--label',
        `${LABEL}=true`,
        '--label',
        `${LABEL_ID}=${harnessId}`,
        '--publish',
        '127.0.0.1::5432',
        '--mount',
        `${mount},readonly`,
        '--env',
        `POSTGRES_PASSWORD=${password}`,
        '--env',
        'POSTGRES_DB=taxonomy_test',
        '--user',
        '0:0',
        '--entrypoint',
        '/bin/sh',
        IMAGE_POSTGRES,
        '-ec',
        `cp /out/server.crt /var/lib/postgresql/server.crt && cp /out/server.key /var/lib/postgresql/server.key && chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key && chmod 600 /var/lib/postgresql/server.key && exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key -c g6.taxonomy_harness_id=${harnessId}`,
      ],
      phase,
      180_000,
    );

    phase = 'consulta del puerto publicado';
    const portText = docker(['port', containerName, '5432/tcp'], phase);
    const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(portText);
    if (!portMatch) throw new Error('PostgreSQL no quedó limitado a loopback.');
    const port = Number(portMatch[1]);

    let ready = false;
    let readinessDiagnostic = '';
    phase = 'readiness PostgreSQL';
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = spawnSync(
        'docker',
        [
          'exec',
          containerName,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-p',
          '5432',
          '-U',
          'postgres',
          '-d',
          'taxonomy_test',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      );
      if (result.status === 0) {
        ready = true;
        break;
      }
      readinessDiagnostic = sanitizarDiagnostico(
        result.stderr || result.stdout || result.error?.message || '',
      );
      await pause(1000);
    }
    if (!ready) {
      throw new Error(
        `PostgreSQL 17 no alcanzó readiness en 60 s.${readinessDiagnostic ? ` Último diagnóstico: ${readinessDiagnostic}` : ''}`,
      );
    }
    phase = 'consulta de versión PostgreSQL';
    const postgresVersion = docker(
      [
        'exec',
        containerName,
        'psql',
        '-U',
        'postgres',
        '-d',
        'taxonomy_test',
        '-Atc',
        "SELECT current_setting('server_version')",
      ],
      phase,
    );

    const vitest = resolve(REPO, 'node_modules/vitest/vitest.mjs');
    if (!existsSync(vitest)) throw new Error('Falta node_modules/vitest.');
    const salida = join(tempDirectory, 'vitest.json');
    const childEnv = {
      ...process.env,
      NODE_EXTRA_CA_CERTS: caFile,
      TAXONOMY_TEST_DATABASE_URL: postgresUrl(port, password, caFile),
      TAXONOMY_TEST_HARNESS_ID: harnessId,
      TAXONOMY_TEST_DB_ACK: 'desechable-aislado',
      TAXONOMY_TEST_DB_EPHEMERAL: '1',
      TAXONOMY_TEST_PG_PORT: String(port),
      TAXONOMY_TEST_PG_CA: caFile,
      TAXONOMY_TEST_PG_CERT: serverCert,
      TAXONOMY_TEST_PG_KEY: serverKey,
    };
    phase = 'ejecución de Vitest dedicado';
    const result = spawnSync(
      process.execPath,
      [
        vitest,
        'run',
        '--config',
        './apps/api-gateway/test/vitest.taxonomy-gateway.config.ts',
        'apps/api-gateway/test/taxonomy-postgres.gateway.integration.ts',
        '--reporter=json',
        `--outputFile=${salida}`,
      ],
      {
        cwd: REPO,
        env: childEnv,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 300_000,
      },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw new Error(`Vitest: ${result.error.message}`);
    if (!existsSync(salida)) {
      throw new Error(`Vitest terminó con código ${result.status} sin JSON.`);
    }
    const report = JSON.parse(readFileSync(salida, 'utf8'));
    const total = report.numTotalTests ?? 0;
    const passed = report.numPassedTests ?? 0;
    const failed = report.numFailedTests ?? 0;
    const skipped = report.numPendingTests ?? 0;
    if (failed > 0) {
      const failures = (report.testResults ?? []).flatMap((suite) =>
        (suite.assertionResults ?? [])
          .filter((test) => test.status === 'failed')
          .map((test) => {
            const detail = sanitizarDiagnostico(
              (test.failureMessages?.[0] ?? 'Fallo sin detalle').split('\n')[0],
              [password],
            )
              .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redactado]')
              .replace(
                /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
                '[JWT redactado]',
              );
            return `  - ${test.fullName ?? test.title}: ${detail}`;
          }),
      );
      console.error(
        `[taxonomy-gateway-e2e] fallas detectadas:\n${failures.join('\n')}`,
      );
    }
    testSummary = `${passed}/${total} PASS, ${failed} FAIL, ${skipped} SKIP; PostgreSQL ${postgresVersion} real con TLS verify-full`;
    if (result.status !== 0 || failed > 0 || skipped > 0 || total === 0) {
      throw new Error('La matriz E2E no terminó íntegramente en PASS.');
    }
  } catch (error) {
    failure = new Error(
      `${phase}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (launchAttempted) {
      phase = 'acreditación y cleanup de PostgreSQL';
      const ownership = acreditarPropiedadContenedor(containerName, harnessId);
      if (ownership.ok) {
        const removal = eliminarContenedor(
          containerName,
          harnessId,
          undefined,
          ownership,
        );
        if (!removal.ok) {
          failure ??= new Error(removal.mensaje);
          cleanupResult = 'FAIL: eliminación rechazada/fallida';
        } else {
          cleanupResult = 'PASS: contenedor propio eliminado';
        }
      } else if (!ownership.ausente) {
        failure ??= new Error(ownership.mensaje);
        cleanupResult = 'FAIL: propiedad no acreditada; no se eliminó';
      } else {
        cleanupResult = 'PASS: contenedor ya ausente';
      }
    }
    const tempRoot = resolve(tmpdir());
    const resolvedTemp = resolve(tempDirectory);
    if (
      resolvedTemp.startsWith(
        `${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`,
      ) &&
      resolvedTemp.includes('g6-taxonomy-gateway-')
    ) {
      rmSync(resolvedTemp, { recursive: true, force: true });
      cleanupResult += '; directorio temporal eliminado';
    } else {
      failure ??= new Error(
        'La ruta temporal no pasó la verificación de limpieza.',
      );
      cleanupResult += '; FAIL: directorio temporal no acreditado';
    }
  }

  console.log(
    `[taxonomy-gateway-e2e] evidencia: SHA=${sha}; Node=${process.versions.node}; Docker=${dockerVersion}; ${testSummary}; cleanup=${cleanupResult}`,
  );
  if (failure) {
    const message =
      failure instanceof Error ? failure.message : String(failure);
    console.error(
      `[taxonomy-gateway-e2e] FAIL: ${sanitizarDiagnostico(message, [password])}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[taxonomy-gateway-e2e] PASS: ${testSummary}; ${cleanupResult}.`);
}

main().catch((error) => {
  console.error(
    `[taxonomy-gateway-e2e] FAIL: ${sanitizarDiagnostico(error instanceof Error ? error.message : String(error))}`,
  );
  process.exitCode = 1;
});
