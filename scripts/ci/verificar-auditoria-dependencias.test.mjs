import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluarAuditorias, EXCEPCION_ADVISORY_ID } from './verificar-auditoria-dependencias.mjs';

const RETIRADO = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';

function crearInforme(vulnerabilities = {}) {
  const conteos = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const vulnerabilidad of Object.values(vulnerabilities)) {
    conteos[vulnerabilidad.severity] += 1;
    conteos.total += 1;
  }
  return JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: conteos } });
}

function registro(severity, via, name) {
  return { name, severity, isDirect: false, via, effects: [], range: '*', nodes: [`node_modules/${name}`] };
}

function advisory(url, severity = 'high', name = 'picomatch') {
  return { source: 1234, name, dependency: name, title: 'advisory fixture', url, severity, range: '*' };
}

function evaluar({ full = {}, production = {}, fullExitCode = 0, productionExitCode = 0, date = '2026-11-18', fullError = null } = {}) {
  return evaluarAuditorias({
    auditoriaCompleta: { stdout: crearInforme(full), stderr: '', exitCode: fullExitCode, error: fullError },
    auditoriaProduccion: { stdout: crearInforme(production), stderr: '', exitCode: productionExitCode, error: null },
    shaEvaluado: 'a'.repeat(40),
    fechaUtc: date,
  });
}

test('auditoría limpia pasa por flujo normal', () => {
  const resultado = evaluar();
  assert.equal(resultado.decision.status, 'PASS');
  assert.equal(resultado.decision.mode, 'normal');
  assert.equal(resultado.exception.applied, false);
});

test('solo el aviso retirado con auditoría productiva limpia pasa con excepción identificada', () => {
  const resultado = evaluar({
    full: {
      picomatch: registro('high', [advisory(RETIRADO)], 'picomatch'),
      fdir: registro('high', ['picomatch'], 'fdir'),
    },
    fullExitCode: 1,
  });
  assert.equal(resultado.decision.status, 'PASS');
  assert.equal(resultado.decision.mode, 'temporary-exception');
  assert.equal(resultado.exception.advisoryId, EXCEPCION_ADVISORY_ID);
  assert.equal(resultado.exception.applied, true);
  assert.deepEqual(resultado.decision.advisoryIds, [EXCEPCION_ADVISORY_ID]);
  assert.deepEqual(resultado.decision.highCriticalPackages.map(({ name }) => name).sort(), ['fdir', 'picomatch']);
});

test('un aviso Moderate en otra rama no se confunde con la causa High permitida', () => {
  const resultado = evaluar({
    full: {
      picomatch: registro('high', [advisory(RETIRADO)], 'picomatch'),
      tinyglobby: registro('high', ['picomatch'], 'tinyglobby'),
      minimatch: registro('moderate', [advisory('https://github.com/advisories/GHSA-abcd-1234-efgh', 'moderate', 'minimatch')], 'minimatch'),
      parser: registro('high', ['tinyglobby', 'minimatch'], 'parser'),
    },
    fullExitCode: 1,
  });
  assert.equal(resultado.decision.status, 'PASS');
  assert.deepEqual(resultado.decision.advisoryIds, [EXCEPCION_ADVISORY_ID]);
});

test('resuelve propagaciones cíclicas del lockfile sin ocultar la raíz del aviso', () => {
  const resultado = evaluar({
    full: {
      '@vitest/coverage-v8': registro('high', ['vitest'], '@vitest/coverage-v8'),
      vitest: registro('high', ['@vitest/coverage-v8', 'picomatch'], 'vitest'),
      picomatch: registro('high', [advisory(RETIRADO)], 'picomatch'),
    },
    fullExitCode: 1,
  });
  assert.equal(resultado.decision.status, 'PASS', resultado.decision.reason);
  assert.deepEqual(resultado.decision.advisoryIds, [EXCEPCION_ADVISORY_ID]);
});

test('aviso retirado junto a otro High falla', () => {
  const resultado = evaluar({
    full: {
      picomatch: registro('high', [advisory(RETIRADO)], 'picomatch'),
      otro: registro('high', [advisory('https://github.com/advisories/GHSA-abcd-1234-efgh', 'high', 'otro')], 'otro'),
    },
    fullExitCode: 1,
  });
  assert.equal(resultado.decision.status, 'FAIL');
});

test('un Critical distinto falla', () => {
  const resultado = evaluar({
    full: { critical: registro('critical', [advisory('https://github.com/advisories/GHSA-abcd-1234-efgh', 'critical', 'critical')], 'critical') },
    fullExitCode: 1,
  });
  assert.equal(resultado.decision.status, 'FAIL');
});

test('cualquier vulnerabilidad productiva falla incluso si el audit threshold no es alcanzado', () => {
  const resultado = evaluar({
    production: { prod: registro('moderate', [advisory('https://github.com/advisories/GHSA-abcd-1234-efgh', 'moderate', 'prod')], 'prod') },
  });
  assert.equal(resultado.decision.status, 'FAIL');
  assert.match(resultado.decision.reason, /producción/);
});

test('aviso permitido con procedencia no demostrable falla', () => {
  const resultado = evaluar({ full: { fdir: registro('high', ['picomatch'], 'fdir') }, fullExitCode: 1 });
  assert.equal(resultado.decision.status, 'FAIL');
  assert.match(resultado.decision.reason, /procedencia no demostrable/);
});

test('JSON inválido falla', () => {
  const resultado = evaluarAuditorias({
    auditoriaCompleta: { stdout: '{', stderr: '', exitCode: 1 },
    auditoriaProduccion: { stdout: crearInforme(), stderr: '', exitCode: 0 },
    shaEvaluado: 'a'.repeat(40),
  });
  assert.equal(resultado.decision.status, 'FAIL');
  assert.match(resultado.decision.reason, /JSON inválido/);
});

test('JSON incompleto o con conteos inconsistentes falla', () => {
  const incompleto = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
  });
  const resultado = evaluarAuditorias({
    auditoriaCompleta: { stdout: incompleto, stderr: '', exitCode: 0 },
    auditoriaProduccion: { stdout: crearInforme(), stderr: '', exitCode: 0 },
    shaEvaluado: 'a'.repeat(40),
  });
  assert.equal(resultado.decision.status, 'FAIL');
  assert.match(resultado.decision.reason, /incompleto o inconsistente/);
});

test('error del registro o transporte falla', () => {
  const resultado = evaluarAuditorias({
    auditoriaCompleta: { stdout: JSON.stringify({ error: { code: 'ENOAUDIT', summary: 'registry unavailable' } }), stderr: 'network failure', exitCode: 1 },
    auditoriaProduccion: { stdout: crearInforme(), stderr: '', exitCode: 0 },
    shaEvaluado: 'a'.repeat(40),
  });
  assert.equal(resultado.decision.status, 'FAIL');
  assert.match(resultado.decision.reason, /incompleto|error del registro/);
  const errorSpawn = evaluarAuditorias({
    auditoriaCompleta: { stdout: '', stderr: '', exitCode: null, error: { message: 'ETIMEDOUT' } },
    auditoriaProduccion: { stdout: crearInforme(), stderr: '', exitCode: 0 },
    shaEvaluado: 'a'.repeat(40),
  });
  assert.equal(errorSpawn.decision.status, 'FAIL');
  const transporte = evaluarAuditorias({
    auditoriaCompleta: {
      stdout: crearInforme({ picomatch: registro('high', [advisory(RETIRADO)], 'picomatch') }),
      stderr: 'npm ERR! ECONNRESET registry connection interrupted',
      exitCode: 1,
    },
    auditoriaProduccion: { stdout: crearInforme(), stderr: '', exitCode: 0 },
    shaEvaluado: 'a'.repeat(40),
  });
  assert.equal(transporte.decision.status, 'FAIL');
  assert.match(transporte.decision.reason, /transporte/);
});

test('la excepción falla después del vencimiento UTC', () => {
  const resultado = evaluar({
    full: { picomatch: registro('high', [advisory(RETIRADO)], 'picomatch') },
    fullExitCode: 1,
    date: '2026-11-26',
  });
  assert.equal(resultado.decision.status, 'FAIL');
  assert.match(resultado.decision.reason, /vencida/);
});

test('la excepción sigue vigente durante todo el 25/11/2026 UTC', () => {
  const resultado = evaluar({
    full: { picomatch: registro('high', [advisory(RETIRADO)], 'picomatch') },
    fullExitCode: 1,
    date: '2026-11-25',
  });
  assert.equal(resultado.decision.status, 'PASS');
  assert.equal(resultado.exception.expiresUtcInclusive, '2026-11-25');
});

test('código de salida npm inesperado falla', () => {
  const resultado = evaluar({ fullExitCode: 2 });
  assert.equal(resultado.decision.status, 'FAIL');
  assert.match(resultado.decision.reason, /código de salida inesperado/);
});

test('si el audit deja de reportar el aviso, pasa normalmente sin usar excepción', () => {
  const resultado = evaluar();
  assert.equal(resultado.decision.status, 'PASS');
  assert.equal(resultado.decision.mode, 'normal');
  assert.equal(resultado.exception.applied, false);
});

test('el job seguridad está conectado al test, auditor y artefacto sin continue-on-error', async () => {
  let workflow;
  try {
    workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  } catch {
    workflow = await readFile('.github/workflows/frontend.yml', 'utf8');
  }
  const start = workflow.indexOf('  seguridad_dependencias:');
  assert.notEqual(start, -1, 'existe el job obligatorio de auditoría');
  const nextJobOffset = workflow.slice(start + 3).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  const block = workflow.slice(start, nextJobOffset < 0 ? undefined : start + 3 + nextJobOffset);
  assert.match(block, /node --test scripts\/ci\/verificar-auditoria-dependencias\.test\.mjs/);
  assert.match(block, /node scripts\/ci\/verificar-auditoria-dependencias\.mjs/);
  assert.match(block, /actions\/upload-artifact/);
  assert.match(block, /dependency-audit-evidence/);
  assert.doesNotMatch(block, /continue-on-error:/);
});
