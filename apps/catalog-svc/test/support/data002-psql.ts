import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export interface Data002Step {
  name: string;
  input: string;
}
export interface Data002Result {
  status: number;
  output: string;
}

/** One Docker transport, independent real psql sessions. A failing script still
 * exits/rolls back its own connection before restoration or the next scenario.
 * Original SQL is passed verbatim; expected failures retain their exit codes. */
export function runData002Psql(
  container: string,
  steps: Data002Step[],
): Map<string, Data002Result> {
  const token = 'DATA002_' + randomUUID().replaceAll('-', '');
  if (new Set(steps.map((step) => step.name)).size !== steps.length)
    throw new Error('Duplicate DATA-002 step');
  const script = steps
    .map((step, index) => {
      const delimiter = token + '_SQL_' + index;
      if (step.input.includes(token))
        throw new Error('Ambiguous DATA-002 framing');
      return `printf '\\036${token}:BEGIN:${index}\\037\\n'
psql -X -q -At -F '|' -U postgres -v ON_ERROR_STOP=1 2>&1 <<'${delimiter}'
${step.input}
${delimiter}
status=$?
printf '\\036${token}:END:${index}:%s\\037\\n' "$status"
`;
    })
    .join('\n');
  const processResult = spawnSync('docker', ['exec', '-i', container, 'sh'], {
    input: script,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  if (processResult.error || processResult.status !== 0)
    throw new Error('DATA-002 isolated Docker transport failed');
  const results = new Map<string, Data002Result>();
  for (const [index, step] of steps.entries()) {
    const pattern = new RegExp(
      '\\x1e' +
        token +
        ':BEGIN:' +
        index +
        '\\x1f\\r?\\n([\\s\\S]*?)\\x1e' +
        token +
        ':END:' +
        index +
        ':(\\d+)\\x1f',
    );
    const match = processResult.stdout.match(pattern);
    if (!match) throw new Error('Missing DATA-002 result: ' + step.name);
    results.set(step.name, {
      status: Number(match[2]),
      output: match[1].trim(),
    });
  }
  return results;
}
