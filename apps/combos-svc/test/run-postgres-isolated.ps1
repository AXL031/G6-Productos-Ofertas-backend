param(
  [switch]$TestEnvironmentRestoration,
  [string]$EvidenceDirectory,
  [ValidateSet('app.e2e-spec.ts', 'combos-postgres.e2e-spec.ts', 'combos-rabbitmq.e2e-spec.ts', 'combos-catalog-rabbitmq.e2e-spec.ts')]
  [string]$TestFile,
  [string]$TestNamePattern
)

$ErrorActionPreference = 'Stop'
$environmentNames = @(
  'COMBOS_TEST_EPHEMERAL', 'COMBOS_TEST_DATABASE_URL', 'COMBOS_TEST_CA',
  'COMBOS_TEST_RABBITMQ_URL', 'COMBOS_TEST_RABBITMQ_CONTAINER', 'COMBOS_TEST_CATALOG_PASSWORD', 'COMBOS_TEST_PRICING_PASSWORD', 'COMBOS_TEST_CWD', 'COMBOS_RUN_ISOLATED_E2E',
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

if ($EvidenceDirectory) {
  if (Test-Path -LiteralPath $EvidenceDirectory) {
    throw "El directorio de evidencia ya existe; no se sobrescribirá: $EvidenceDirectory"
  }
  $null = New-Item -ItemType Directory -Path $EvidenceDirectory
  $EvidenceDirectory = (Resolve-Path -LiteralPath $EvidenceDirectory).Path
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
$catalogMigration = Join-Path $docsRoot 'datos\catalog-svc\migrations\0001_create_catalog.sql'
$pricingMigration = Join-Path $repoRoot 'apps\pricing-svc\test\fixtures\pricing.sql'
$pricingOfficialMigration = Join-Path $docsRoot 'datos\pricing\migrations\0001_create_pricing.sql'
$pricingContextMigration = Join-Path $repoRoot 'apps\pricing-svc\migrations\0002_schedule_effective_events.sql'
foreach ($requiredMigration in @($migration, $catalogMigration, $pricingMigration, $pricingOfficialMigration, $pricingContextMigration)) {
  if (-not (Test-Path -LiteralPath $requiredMigration)) { throw "No se encontró la migración oficial: $requiredMigration" }
}
$pricingFixtureText = ([IO.File]::ReadAllText($pricingMigration) -replace "`r`n", "`n")
$pricingOfficialText = ([IO.File]::ReadAllText($pricingOfficialMigration) -replace "`r`n", "`n")
if ($pricingFixtureText -cne $pricingOfficialText) { throw 'La fixture Pricing no coincide con la migración oficial fijada.' }
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
$catalogRandomBytes = [byte[]]::new(24)
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($catalogRandomBytes)
$catalogPassword = [BitConverter]::ToString($catalogRandomBytes).Replace('-', '')
$pricingRandomBytes = [byte[]]::new(24)
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($pricingRandomBytes)
$pricingPassword = [BitConverter]::ToString($pricingRandomBytes).Replace('-', '')
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
  & docker exec $container psql -U postgres -d combos_test -v ON_ERROR_STOP=1 -c "CREATE ROLE po_combos_owner NOLOGIN; CREATE ROLE po_catalog_owner NOLOGIN; CREATE ROLE po_pricing_owner NOLOGIN; CREATE ROLE catalog_app LOGIN PASSWORD '$catalogPassword'; CREATE ROLE pricing_app LOGIN PASSWORD '$pricingPassword'; CREATE SCHEMA combos AUTHORIZATION po_combos_owner; CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner; CREATE SCHEMA pricing AUTHORIZATION po_pricing_owner; CREATE SCHEMA extensions; CREATE EXTENSION btree_gist WITH SCHEMA extensions; GRANT USAGE ON SCHEMA extensions TO po_pricing_owner;"
  if ($LASTEXITCODE -ne 0) { throw "No se pudieron preparar owners/schemas de prueba en la base desechable (psql exit $LASTEXITCODE)." }
  foreach ($migrationSpec in @(
    @{ Path = $catalogMigration; Owner = 'po_catalog_owner'; Name = 'catalog' },
    @{ Path = $migration; Owner = 'po_combos_owner'; Name = 'combos' },
    @{ Path = $pricingMigration; Owner = 'po_pricing_owner'; Name = 'pricing' },
    @{ Path = $pricingContextMigration; Owner = 'po_pricing_owner'; Name = 'pricing-context' }
  )) {
    $migrationSql = [IO.File]::ReadAllText($migrationSpec.Path)
    $bootstrapSql = Join-Path $folder "apply-$($migrationSpec.Name).sql"
    [IO.File]::WriteAllText($bootstrapSql, "SET ROLE $($migrationSpec.Owner);`n$migrationSql", [Text.UTF8Encoding]::new($false))
    & docker cp $bootstrapSql "${container}:/tmp/apply-$($migrationSpec.Name).sql" | Out-Null
    & docker exec $container psql -U postgres -d combos_test -v ON_ERROR_STOP=1 -f "/tmp/apply-$($migrationSpec.Name).sql"
    if ($LASTEXITCODE -ne 0) { throw "Falló la migración oficial de $($migrationSpec.Name) en la instancia desechable (psql exit $LASTEXITCODE)." }
  }
  $env:COMBOS_TEST_EPHEMERAL = '1'; $env:COMBOS_TEST_DATABASE_URL = 'harness-owned'; $env:COMBOS_TEST_CA = Join-Path $folder 'server.crt'
  $env:COMBOS_TEST_CATALOG_PASSWORD = $catalogPassword
  $env:COMBOS_TEST_PRICING_PASSWORD = $pricingPassword
  $env:COMBOS_TEST_CWD = $folder
  $env:COMBOS_TEST_RABBITMQ_URL = "amqp://combos_test:${rabbitPassword}@127.0.0.1:${rabbitPort}/%2f"
  $env:COMBOS_TEST_RABBITMQ_CONTAINER = $rabbitContainer
  Write-Output "HARNESS_FIXTURES: isolated=$($env:COMBOS_TEST_EPHEMERAL -eq '1') database=$($env:COMBOS_TEST_DATABASE_URL -eq 'harness-owned') rabbit=$($env:COMBOS_TEST_RABBITMQ_URL.StartsWith('amqp://')) catalogCredential=$([bool]$env:COMBOS_TEST_CATALOG_PASSWORD)"
  $env:PGPORT = $port; $env:PGDATABASE = 'combos_test'; $env:PGUSER = 'postgres'; $env:PGPASSWORD = $password
  $env:PGHOST = '127.0.0.1'; $env:PGSSLMODE = 'verify-full'; $env:PGSSLROOTCERT = $env:COMBOS_TEST_CA
  Push-Location $repoRoot
  & npm.cmd run build:catalog-svc
  if ($LASTEXITCODE -ne 0) { throw 'Falló el build de Catalog requerido por la suite de integración real.' }
  & npm.cmd run build:pricing-svc
  if ($LASTEXITCODE -ne 0) { throw 'Falló el build de Pricing requerido por la suite de integración real.' }
  $testTarget = if ($TestFile) { "apps/combos-svc/test/$TestFile" } else { 'apps/combos-svc' }
  $testArguments = @($testTarget, '--maxWorkers=1', '--no-file-parallelism')
  if ($TestNamePattern) { $testArguments += @('--testNamePattern', $TestNamePattern) }
  $testReport = Join-Path $folder 'vitest-results.json'
  $testArguments += @('--reporter=json', '--reporter=default', "--outputFile=$testReport")
  try {
    $env:COMBOS_RUN_ISOLATED_E2E = '1'
    & npm.cmd run test:e2e -- @testArguments
    if ($LASTEXITCODE -ne 0) { throw 'Fallaron las pruebas E2E de Combos.' }
    if (-not (Test-Path -LiteralPath $testReport)) { throw 'Vitest no produjo el reporte JSON requerido.' }
    $testResult = [IO.File]::ReadAllText($testReport) | ConvertFrom-Json
    $expectedFiles = if ($TestFile) { @($TestFile) } else { @('app.e2e-spec.ts', 'combos-postgres.e2e-spec.ts', 'combos-rabbitmq.e2e-spec.ts', 'combos-catalog-rabbitmq.e2e-spec.ts') }
    if (
      -not ($testResult.PSObject.Properties.Name -contains 'numPassedTests') -or
      -not ($testResult.PSObject.Properties.Name -contains 'numFailedTests') -or
      -not ($testResult.PSObject.Properties.Name -contains 'numPendingTests') -or
      -not ($testResult.PSObject.Properties.Name -contains 'numTodoTests') -or
      -not ($testResult.PSObject.Properties.Name -contains 'numTotalTests') -or
      -not ($testResult.PSObject.Properties.Name -contains 'numTotalTestSuites') -or
      -not ($testResult.PSObject.Properties.Name -contains 'numPassedTestSuites') -or
      -not ($testResult.PSObject.Properties.Name -contains 'numFailedTestSuites') -or
      -not ($testResult.PSObject.Properties.Name -contains 'numPendingTestSuites') -or
      -not ($testResult.PSObject.Properties.Name -contains 'testResults') -or
      [int]$testResult.numPassedTests -lt 1 -or
      [int]$testResult.numFailedTests -ne 0 -or
      [int]$testResult.numPendingTests -ne 0 -or
      [int]$testResult.numTodoTests -ne 0 -or
      [int]$testResult.numTotalTests -ne ([int]$testResult.numPassedTests + [int]$testResult.numFailedTests + [int]$testResult.numPendingTests + [int]$testResult.numTodoTests) -or
      [int]$testResult.numTotalTestSuites -lt $expectedFiles.Count -or
      [int]$testResult.numPassedTestSuites -ne [int]$testResult.numTotalTestSuites -or
      [int]$testResult.numFailedTestSuites -ne 0 -or
      [int]$testResult.numPendingTestSuites -ne 0
    ) { throw 'La suite E2E crítica quedó sin pruebas ejecutadas, con fallos o con pruebas omitidas.' }
    $reportedFiles = @($testResult.testResults | ForEach-Object { [IO.Path]::GetFileName([string]$_.name) })
    if (@($testResult.testResults | Where-Object { $_.status -ne 'passed' }).Count -ne 0) { throw 'Vitest reportó una suite que no terminó en estado passed.' }
    foreach ($expectedFile in $expectedFiles) {
      if (@($reportedFiles | Where-Object { $_ -eq $expectedFile }).Count -ne 1) {
        throw "La suite E2E prevista no aparece exactamente una vez en el reporte: $expectedFile"
      }
    }
    if ($reportedFiles.Count -ne $expectedFiles.Count) { throw 'Vitest ejecutó un inventario de suites distinto al esperado.' }
    Write-Output "HARNESS_TEST_COUNTS: PASS passed=$($testResult.numPassedTests) failed=$($testResult.numFailedTests) skipped=$($testResult.numPendingTests)"
    if ($EvidenceDirectory) {
      Copy-Item -LiteralPath $testReport -Destination (Join-Path $EvidenceDirectory 'vitest-results.json')
      $sha = (& git -C $repoRoot rev-parse HEAD).Trim()
      $status = & git -C $repoRoot status --short
      @("result=PASS", "sha=$sha", "passed=$($testResult.numPassedTests)", "failed=$($testResult.numFailedTests)", "skipped=$($testResult.numPendingTests)", "suites=$($reportedFiles -join ',')", "working_tree_status:", $status) |
        Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'run-summary.txt') -Encoding utf8
      Write-Output "HARNESS_EVIDENCE: $EvidenceDirectory"
    }
  }
  finally { Pop-Location }
} catch {
  Write-Host "HARNESS_FAILURE: $($_.Exception.Message)"
  if (Get-Variable -Name testReport -ErrorAction SilentlyContinue) {
    if (Test-Path -LiteralPath $testReport) {
      try {
        $failedReport = [IO.File]::ReadAllText($testReport) | ConvertFrom-Json
        foreach ($suite in $failedReport.testResults) {
          foreach ($assertion in $suite.assertionResults | Where-Object { $_.status -eq 'failed' }) {
            Write-Host "TEST_FAILURE[$([IO.Path]::GetFileName([string]$suite.name))]: $($assertion.fullName)"
            Write-Host ($assertion.failureMessages -join "`n")
          }
        }
        Write-Host "HARNESS_TEST_COUNTS: passed=$($failedReport.numPassedTests) failed=$($failedReport.numFailedTests) skipped=$($failedReport.numPendingTests)"
        if ($EvidenceDirectory) {
          Copy-Item -LiteralPath $testReport -Destination (Join-Path $EvidenceDirectory 'vitest-results.json')
          @("result=FAIL", "sha=$((& git -C $repoRoot rev-parse HEAD).Trim())", "passed=$($failedReport.numPassedTests)", "failed=$($failedReport.numFailedTests)", "skipped=$($failedReport.numPendingTests)") |
            Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'run-summary.txt') -Encoding utf8
        }
      } catch { Write-Host "HARNESS_REPORT_DIAGNOSTIC_FAILURE: $($_.Exception.Message)" }
    }
  }
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
