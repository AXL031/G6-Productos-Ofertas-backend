param(
  [switch]$TestEnvironmentRestoration,
  [ValidateSet('app.e2e-spec.ts', 'combos-postgres.e2e-spec.ts', 'combos-rabbitmq.e2e-spec.ts')]
  [string]$TestFile,
  [string]$TestNamePattern
)

$ErrorActionPreference = 'Stop'
$environmentNames = @(
  'COMBOS_TEST_EPHEMERAL', 'COMBOS_TEST_DATABASE_URL', 'COMBOS_TEST_CA',
  'COMBOS_TEST_RABBITMQ_URL', 'COMBOS_TEST_RABBITMQ_CONTAINER',
  'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGHOST', 'PGSSLMODE', 'PGSSLROOTCERT'
)
$originalEnvironment = @{}
$processEnvironment = [Environment]::GetEnvironmentVariables('Process')
foreach ($name in $environmentNames) {
  $originalEnvironment[$name] = @{
    Defined = $processEnvironment.Contains($name)
    Value = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
}

function Restore-HarnessEnvironment {
  foreach ($name in $environmentNames) {
    $original = $originalEnvironment[$name]
    if ($original.Defined) { [Environment]::SetEnvironmentVariable($name, $original.Value, 'Process') }
    else { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  }
}

if ($TestEnvironmentRestoration) {
  try {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, 'harness-restoration-test', 'Process') }
    throw 'Simulated harness failure for environment restoration verification.'
  }
  catch { }
  finally { Restore-HarnessEnvironment }
  foreach ($name in $environmentNames) {
    $actualDefined = [Environment]::GetEnvironmentVariables('Process').Contains($name)
    $actualValue = [Environment]::GetEnvironmentVariable($name, 'Process')
    $original = $originalEnvironment[$name]
    if ($actualDefined -ne $original.Defined -or $actualValue -cne $original.Value) {
      throw "La restauración del entorno falló para $name."
    }
  }
  Write-Output 'ENV_RESTORATION_TEST: PASS'
  exit 0
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$docsCandidate = if ($env:COMBOS_TEST_DOCS_ROOT) { $env:COMBOS_TEST_DOCS_ROOT } else { Join-Path $repoRoot '..\docs' }
$docsRoot = (Resolve-Path $docsCandidate).Path
$migration = Join-Path $docsRoot 'datos\combos\migrations\0001_create_combos_persistence.sql'
if (-not (Test-Path -LiteralPath $migration)) { throw "No se encontró la migración oficial: $migration" }
$dockerInfo = & docker info --format '{{.ServerVersion}}' 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Docker daemon no disponible; PostgreSQL aislado no ejecutado.' }
$id = [guid]::NewGuid().ToString('N')
$container = "g6-combos-it-$($id.Substring(0,12))"
$rabbitContainer = "g6-combos-rabbit-it-$($id.Substring(0,12))"
$folder = Join-Path ([IO.Path]::GetTempPath()) "g6-combos-it-$id"
$folder = [IO.Path]::GetFullPath($folder)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $folder.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Directorio temporal fuera del área permitida.' }
$randomBytes = [byte[]]::new(24)
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($randomBytes)
$password = [BitConverter]::ToString($randomBytes).Replace('-', '')
$harnessLabel = 'com.taller-sw.g6.combos-harness'
$started = $false
$rabbitStarted = $false
$rabbitRandomBytes = [byte[]]::new(24)
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rabbitRandomBytes)
$rabbitPassword = [BitConverter]::ToString($rabbitRandomBytes).Replace('-', '')

function Assert-ContainerRunning([string]$Name, [string]$Stage) {
  $running = & docker inspect --format '{{.State.Running}}' $Name 2>$null
  if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
    throw "${Stage}: el contenedor $Name dejó de estar activo."
  }
}

try {
  New-Item -ItemType Directory -Path $folder | Out-Null
  & docker run --rm --user root --volume "${folder}:/cert" --entrypoint sh rabbitmq:4.2.9-alpine -c "openssl req -x509 -nodes -newkey rsa:2048 -keyout /cert/server.key -out /cert/server.crt -days 1 -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1' && chmod 600 /cert/server.key && chown 70:70 /cert/server.key /cert/server.crt" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo generar el certificado TLS aislado.' }
  & docker run --detach --name $container --label "$harnessLabel=true" --label "com.taller-sw.g6.combos-harness-id=$id" --publish '127.0.0.1::5432' --volume "${folder}:/cert:ro" --env "POSTGRES_PASSWORD=$password" --env 'POSTGRES_DB=combos_test' postgres:17-alpine postgres -c ssl=on -c ssl_cert_file=/cert/server.crt -c ssl_key_file=/cert/server.key | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar PostgreSQL 17 desechable.' }
  $started = $true
  $ready = $false
  for ($i=0; $i -lt 60; $i++) { & docker exec $container pg_isready -U postgres -d combos_test *> $null; if ($LASTEXITCODE -eq 0) { $ready=$true; break }; Start-Sleep -Seconds 1 }
  if (-not $ready) { & docker logs $container 2>&1 | Select-Object -Last 30; throw 'PostgreSQL desechable no alcanzó readiness.' }
  Assert-ContainerRunning $container 'PostgreSQL después de readiness'
  $portLine = & docker port $container '5432/tcp'
  if ($portLine -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'PostgreSQL no quedó publicado en loopback.' }
  $port = $Matches[1]
  & docker run --detach --name $rabbitContainer --label "$harnessLabel=true" --label "com.taller-sw.g6.combos-harness-id=$id" --publish '127.0.0.1::5672' --env 'RABBITMQ_DEFAULT_USER=combos_test' --env "RABBITMQ_DEFAULT_PASS=$rabbitPassword" rabbitmq:4.2.9-alpine | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar RabbitMQ 4.2.9 desechable.' }
  $rabbitStarted = $true
  $rabbitReady = $false
  for ($i=0; $i -lt 60; $i++) {
    & docker exec --user rabbitmq $rabbitContainer rabbitmq-diagnostics -q check_running *> $null
    $nodeRunning = $LASTEXITCODE -eq 0
    if ($nodeRunning) {
      & docker exec --user rabbitmq $rabbitContainer rabbitmq-diagnostics -q check_port_connectivity *> $null
      $rabbitReady = $LASTEXITCODE -eq 0
    }
    if ($rabbitReady) { break }
    Assert-ContainerRunning $rabbitContainer 'RabbitMQ durante readiness'
    Start-Sleep -Seconds 1
  }
  if (-not $rabbitReady) { throw 'RabbitMQ desechable no completó readiness de nodo y listeners AMQP.' }
  $rabbitPortLine = & docker port $rabbitContainer '5672/tcp'
  if ($rabbitPortLine -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'RabbitMQ no quedó publicado en loopback.' }
  $rabbitPort = [int]$Matches[1]
  Assert-ContainerRunning $container 'PostgreSQL antes de preparar el esquema'
  Assert-ContainerRunning $rabbitContainer 'RabbitMQ antes de preparar el esquema'
  & docker exec $container psql -U postgres -d combos_test -v ON_ERROR_STOP=1 -c 'CREATE ROLE po_combos_owner NOLOGIN; CREATE SCHEMA combos AUTHORIZATION po_combos_owner;'
  if ($LASTEXITCODE -ne 0) { throw "No se pudo preparar el owner/schema propio en la base desechable (psql exit $LASTEXITCODE)." }
  $migrationSql = [IO.File]::ReadAllText($migration)
  $bootstrapSql = Join-Path $folder 'apply-combos.sql'
  [IO.File]::WriteAllText($bootstrapSql, "SET ROLE po_combos_owner;`n$migrationSql", [Text.UTF8Encoding]::new($false))
  & docker cp $bootstrapSql "${container}:/tmp/apply-combos.sql" | Out-Null
  & docker exec $container psql -U postgres -d combos_test -v ON_ERROR_STOP=1 -f /tmp/apply-combos.sql
  if ($LASTEXITCODE -ne 0) { throw "Falló la migración oficial en la instancia desechable (psql exit $LASTEXITCODE)." }
  $env:COMBOS_TEST_EPHEMERAL = '1'; $env:COMBOS_TEST_DATABASE_URL = 'harness-owned'; $env:COMBOS_TEST_CA = Join-Path $folder 'server.crt'
  $env:COMBOS_TEST_RABBITMQ_URL = "amqp://combos_test:${rabbitPassword}@127.0.0.1:${rabbitPort}/%2f"
  $env:COMBOS_TEST_RABBITMQ_CONTAINER = $rabbitContainer
  $env:PGPORT = $port; $env:PGDATABASE = 'combos_test'; $env:PGUSER = 'postgres'; $env:PGPASSWORD = $password
  $env:PGHOST = '127.0.0.1'; $env:PGSSLMODE = 'verify-full'; $env:PGSSLROOTCERT = $env:COMBOS_TEST_CA
  Push-Location $repoRoot
  $testTarget = if ($TestFile) { "apps/combos-svc/test/$TestFile" } else { 'apps/combos-svc' }
  $testArguments = @($testTarget, '--maxWorkers=1', '--no-file-parallelism')
  if ($TestNamePattern) { $testArguments += @('--testNamePattern', $TestNamePattern) }
  try { & npm.cmd run test:e2e -- @testArguments; if ($LASTEXITCODE -ne 0) { throw 'Fallaron las pruebas E2E de Combos.' } }
  finally { Pop-Location }
} catch {
  Write-Host "HARNESS_FAILURE: $($_.Exception.Message)"
  foreach ($target in @($container, $rabbitContainer)) {
    $inspect = & docker inspect --format '{{json .State}}|{{.Config.Image}}|{{json .Config.Labels}}|{{json .HostConfig.Memory}}' $target 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Host "CONTAINER_INSPECT[$target]: $inspect" }
    else { Write-Host "CONTAINER_INSPECT[$target]: unavailable (inspect exit $LASTEXITCODE)" }
    $logs = & docker logs --timestamps --tail 100 $target 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Host "CONTAINER_LOGS[$target]:"; $logs | ForEach-Object { Write-Host $_ } }
    else { Write-Host "CONTAINER_LOGS[$target]: unavailable (logs exit $LASTEXITCODE)" }
  }
  throw
}
finally {
  if ($started) {
    $labelsJson = & docker inspect --format '{{json .Config.Labels}}' $container 2>$null
    $ownerId = if ($LASTEXITCODE -eq 0) { ($labelsJson | ConvertFrom-Json).'com.taller-sw.g6.combos-harness-id' } else { '' }
    if ($ownerId -eq $id) { & docker rm --force $container | Out-Null }
  }
  if ($rabbitStarted) {
    $labelsJson = & docker inspect --format '{{json .Config.Labels}}' $rabbitContainer 2>$null
    $ownerId = if ($LASTEXITCODE -eq 0) { ($labelsJson | ConvertFrom-Json).'com.taller-sw.g6.combos-harness-id' } else { '' }
    if ($ownerId -eq $id) { & docker rm --force $rabbitContainer | Out-Null }
  }
  Restore-HarnessEnvironment
  if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder -Recurse -Force }
}
