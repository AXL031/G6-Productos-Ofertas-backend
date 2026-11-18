const changedFiles = process.argv.slice(2);
const onlyAgentsPolicy =
  changedFiles.length === 1 && changedFiles[0] === 'AGENTS.md';

process.stdout.write(`aplica=${!onlyAgentsPolicy}\n`);
