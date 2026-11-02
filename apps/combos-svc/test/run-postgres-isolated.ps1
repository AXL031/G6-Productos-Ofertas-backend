$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$docsRoot = (Resolve-Path (Join-Path $repoRoot '..\docs')).Path
$migration = Join-Path $docsRoot 'datos\combos\migrations\0001_create_combos_persistence.sql'
if (-not (Test-Path -LiteralPath $migration)) { throw "No se encontró la migración oficial: $migration" }
$dockerInfo = & docker info --format '{{.ServerVersion}}' 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Docker daemon no disponible; PostgreSQL aislado no ejecutado.' }
$id = [guid]::NewGuid().ToString('N')
$container = "g6-combos-it-$($id.Substring(0,12))"
$folder = Join-Path ([IO.Path]::GetTempPath()) "g6-combos-it-$id"
$folder = [IO.Path]::GetFullPath($folder)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $folder.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Directorio temporal fuera del área permitida.' }
$password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
$harnessLabel = 'com.taller-sw.g6.combos-harness'
$started = $false
try {
  New-Item -ItemType Directory -Path $folder | Out-Null
  & docker run --rm --volume "${folder}:/cert" alpine:3.22 sh -c "apk add --no-cache openssl >/dev/null && openssl req -x509 -nodes -newkey rsa:2048 -keyout /cert/server.key -out /cert/server.crt -days 1 -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1' && chmod 600 /cert/server.key && chown 70:70 /cert/server.key /cert/server.crt" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo generar el certificado TLS aislado.' }
  & docker run --detach --name $container --label "$harnessLabel=true" --label "com.taller-sw.g6.combos-harness-id=$id" --publish '127.0.0.1::5432' --volume "${folder}:/cert:ro" --env "POSTGRES_PASSWORD=$password" --env 'POSTGRES_DB=combos_test' postgres:17-alpine postgres -c ssl=on -c ssl_cert_file=/cert/server.crt -c ssl_key_file=/cert/server.key | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar PostgreSQL 17 desechable.' }
  $started = $true
  $ready = $false
  for ($i=0; $i -lt 60; $i++) { & docker exec $container pg_isready -U postgres -d combos_test *> $null; if ($LASTEXITCODE -eq 0) { $ready=$true; break }; Start-Sleep -Seconds 1 }
  if (-not $ready) { & docker logs $container 2>&1 | Select-Object -Last 30; throw 'PostgreSQL desechable no alcanzó readiness.' }
  $portLine = & docker port $container '5432/tcp'
  if ($portLine -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'PostgreSQL no quedó publicado en loopback.' }
  $port = $Matches[1]
  & docker exec $container psql -U postgres -d combos_test -v ON_ERROR_STOP=1 -c 'CREATE ROLE po_combos_owner NOLOGIN; CREATE SCHEMA combos AUTHORIZATION po_combos_owner;'
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el owner/schema propio en la base desechable.' }
  $migrationSql = [IO.File]::ReadAllText($migration)
  $bootstrapSql = Join-Path $folder 'apply-combos.sql'
  [IO.File]::WriteAllText($bootstrapSql, "SET ROLE po_combos_owner;`n$migrationSql", [Text.UTF8Encoding]::new($false))
  & docker cp $bootstrapSql "${container}:/tmp/apply-combos.sql" | Out-Null
  & docker exec $container psql -U postgres -d combos_test -v ON_ERROR_STOP=1 -f /tmp/apply-combos.sql
  if ($LASTEXITCODE -ne 0) { throw 'Falló la migración oficial en la instancia desechable.' }
  $env:COMBOS_TEST_EPHEMERAL = '1'; $env:COMBOS_TEST_DATABASE_URL = 'harness-owned'; $env:COMBOS_TEST_CA = Join-Path $folder 'server.crt'
  $env:PGPORT = $port; $env:PGDATABASE = 'combos_test'; $env:PGUSER = 'postgres'; $env:PGPASSWORD = $password
  $env:PGHOST = '127.0.0.1'; $env:PGSSLMODE = 'verify-full'; $env:PGSSLROOTCERT = $env:COMBOS_TEST_CA
  Push-Location $repoRoot
  try { & npm.cmd run test:e2e -- apps/combos-svc; if ($LASTEXITCODE -ne 0) { throw 'Fallaron las pruebas E2E de Combos.' } }
  finally { Pop-Location }
}
finally {
  if ($started) {
    $owner = & docker inspect --format "{{ index .Config.Labels `"$harnessLabel`" }}|{{ index .Config.Labels `"com.taller-sw.g6.combos-harness-id`" }}" $container 2>$null
    if ($LASTEXITCODE -eq 0 -and $owner -eq "true|$id") { & docker rm --force $container | Out-Null }
  }
  foreach ($name in @('COMBOS_TEST_EPHEMERAL','COMBOS_TEST_DATABASE_URL','COMBOS_TEST_CA','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGHOST','PGSSLMODE','PGSSLROOTCERT')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder -Recurse -Force }
}
