#!/usr/bin/env node

const [serializedResults, ...requiredJobs] = process.argv.slice(2);

if (!serializedResults || requiredJobs.length === 0) {
  console.error('FALLO: indique los resultados y la lista de verificaciones obligatorias.');
  process.exit(2);
}

let results;
try {
  results = JSON.parse(serializedResults);
} catch {
  console.error('FALLO: los resultados recibidos no son JSON válido.');
  process.exit(2);
}

const failures = requiredJobs.flatMap((job) => {
  const result = results[job]?.result;
  return result === 'success' ? [] : [`${job}: ${result ?? 'ausente'}`];
});

if (failures.length > 0) {
  console.error(`FALLO: verificaciones no satisfactorias (${failures.join('; ')}).`);
  process.exit(1);
}

console.log(`Correcto: ${requiredJobs.length} verificaciones obligatorias satisfactorias.`);
