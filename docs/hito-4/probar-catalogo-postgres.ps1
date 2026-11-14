param(
  [Parameter(Mandatory)] [string]$PostgresBin,
  [string]$OpenSsl = 'openssl',
  [string]$Psql,
  [string]$CombosBaselineMigration
)

$ErrorActionPreference = 'Stop'
$PostgresBin = (Resolve-Path -LiteralPath $PostgresBin).Path
if (!$Psql) { $Psql = Join-Path $PostgresBin 'psql.exe' }
if ($CombosBaselineMigration) {
  $CombosBaselineMigration = (Resolve-Path -LiteralPath $CombosBaselineMigration).Path.Replace('\', '/')
  if ($CombosBaselineMigration -match "['\r\n]") { throw 'Ruta de migración Combos inválida' }
}
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$temp = [System.IO.Path]::GetTempPath()
$fixture = Join-Path $temp ('g6-h4-catalog-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$data = Join-Path $fixture 'data'
$pgCtl = Join-Path $PostgresBin 'pg_ctl.exe'
$started = $false
$priorEnvironment = @{}
foreach ($name in @('PGPASSWORD', 'PGSSLMODE', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGSSLROOTCERT', 'G6_CONNECT_HOST', 'G6_DATABASE_SCHEMA', 'G6_EXPECTED_ROLE', 'G6_CONNECTION_MODE', 'CATALOG_H4_NATIVE_POSTGRES', 'COMBOS_TEST_EPHEMERAL', 'COMBOS_TEST_DATABASE_URL', 'COMBOS_TEST_CA', 'COMBOS_RUN_ISOLATED_E2E')) {
  $priorEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
function Assert-FixtureCommand([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step falló con código $LASTEXITCODE" }
}

Push-Location -LiteralPath $workspace
try {
  $bootstrapPassword = [guid]::NewGuid().ToString('N')
  $runtimePassword = [guid]::NewGuid().ToString('N')
  $passwordFile = Join-Path $fixture 'bootstrap-password'
  Set-Content -LiteralPath $passwordFile -Encoding ascii -Value $bootstrapPassword
  & (Join-Path $PostgresBin 'initdb.exe') -D $data -U postgres --encoding=UTF8 --no-locale -A scram-sha-256 "--pwfile=$passwordFile"
  Assert-FixtureCommand 'initdb'
  Remove-Item -LiteralPath $passwordFile
  $cert = Join-Path $data 'server.crt'
  & $OpenSsl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -keyout (Join-Path $data 'server.key') -out $cert
  Assert-FixtureCommand 'OpenSSL'
  $socket = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $socket.Start()
  $port = $socket.LocalEndpoint.Port
  $socket.Stop()
  & $pgCtl -D $data -l (Join-Path $fixture 'postgres.log') -o "-p $port -h 127.0.0.1 -c ssl=on" -w start
  Assert-FixtureCommand 'pg_ctl start'
  $started = $true
  $env:PGPASSWORD = $bootstrapPassword
  $env:PGSSLMODE = 'require'
  @"
CREATE ROLE po_catalog_owner NOLOGIN;
CREATE ROLE catalog_app LOGIN PASSWORD '$runtimePassword';
CREATE DATABASE h4_catalog_isolated;
\connect h4_catalog_isolated
CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner;
SET ROLE po_catalog_owner;
\i apps/catalog-svc/test/fixtures/0001_create_catalog.sql
\i apps/catalog-svc/migrations/0002_create_sku_barcodes.sql
\i apps/catalog-svc/migrations/0003_product_publication_history.sql
\i apps/catalog-svc/migrations/0004_historical_preparation_requests.sql
"@ | & $Psql -X -h 127.0.0.1 -p $port -U postgres -d postgres -v ON_ERROR_STOP=1 -q
  Assert-FixtureCommand 'psql'
  $env:PGHOST = 'localhost'
  $env:G6_CONNECT_HOST = '127.0.0.1'
  $env:PGPORT = "$port"
  $env:PGDATABASE = 'h4_catalog_isolated'
  $env:PGUSER = 'catalog_app'
  $env:PGPASSWORD = $runtimePassword
  $env:PGSSLMODE = 'verify-full'
  $env:PGSSLROOTCERT = $cert
  $env:G6_DATABASE_SCHEMA = 'catalog'
  $env:G6_EXPECTED_ROLE = 'catalog_app'
  $env:G6_CONNECTION_MODE = 'direct'
  $env:CATALOG_H4_NATIVE_POSTGRES = '1'
  npm.cmd run test:e2e -- --maxWorkers=1 apps/catalog-svc/test/catalog-admin-native-postgres.e2e-spec.ts
  Assert-FixtureCommand 'Catálogo H4 PostgreSQL'
  if ($CombosBaselineMigration) {
    $env:PGPASSWORD = $bootstrapPassword
    $env:PGSSLMODE = 'require'
    @"
CREATE ROLE po_combos_owner NOLOGIN;
CREATE SCHEMA combos AUTHORIZATION po_combos_owner;
SET ROLE po_combos_owner;
\i '$CombosBaselineMigration'
\i apps/combos-svc/migrations/0002_create_combo_creation_receipts.sql
"@ | & $Psql -X -h 127.0.0.1 -p $port -U postgres -d h4_catalog_isolated -v ON_ERROR_STOP=1 -q
    Assert-FixtureCommand 'psql Combos'
    $env:COMBOS_TEST_EPHEMERAL = '1'
    $env:COMBOS_TEST_DATABASE_URL = 'harness-owned'
    $env:COMBOS_TEST_CA = $cert
    $env:COMBOS_RUN_ISOLATED_E2E = '1'
    $env:PGHOST = '127.0.0.1'
    $env:PGUSER = 'postgres'
    $env:PGSSLMODE = 'verify-full'
    npm.cmd run test:e2e -- --maxWorkers=1 apps/combos-svc/test/combos-postgres.e2e-spec.ts
    Assert-FixtureCommand 'Combos H4 PostgreSQL'
  }
} finally {
  Pop-Location
  foreach ($name in $priorEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $priorEnvironment[$name], 'Process')
  }
  if ($started) {
    & $pgCtl -D $data -m fast -w stop
    Assert-FixtureCommand 'pg_ctl stop'
  }
  $absolute = (Resolve-Path -LiteralPath $fixture).Path
  $relative = [System.IO.Path]::GetRelativePath($temp, $absolute)
  if ($relative -notmatch '^g6-h4-catalog-[a-f0-9]{32}$') {
    throw 'Ruta de limpieza de fixture no válida'
  }
  Remove-Item -LiteralPath $absolute -Recurse -Force
}
