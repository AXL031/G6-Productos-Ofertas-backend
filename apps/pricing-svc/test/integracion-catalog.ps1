param(
  [Parameter(Mandatory = $true)][string]$CatalogSha,
  [Parameter(Mandatory = $true)][string]$PricingSha
)

$ErrorActionPreference = 'Stop'
foreach ($sha in @($CatalogSha, $PricingSha)) {
  if ($sha -cnotmatch '^[a-f0-9]{40}$') { throw 'Se requiere un SHA completo.' }
}
$root = (git rev-parse --show-toplevel).Trim()
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('pricing-catalog-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $archive = Join-Path $tmp 'catalog.tar'
  git -C $root archive --format=tar --output=$archive $CatalogSha
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo exportar Catalog.' }
  tar -xf $archive -C $tmp
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo extraer Catalog.' }
  $pin = Join-Path $tmp 'apps/catalog-svc/test/support/pinned-peer-source.ts'
  $source = [System.IO.File]::ReadAllText($pin)
  $old = '807189f7ca49d4af3b4ad367043260bc3050fb3d'
  if (([regex]::Matches($source, $old)).Count -ne 1) { throw 'El pin original no aparece exactamente una vez.' }
  [System.IO.File]::WriteAllText($pin, $source.Replace($old, $PricingSha))
  New-Item -ItemType Junction -Path (Join-Path $tmp 'node_modules') -Target (Join-Path $root 'node_modules') | Out-Null
  Write-Host "CATALOG_SHA=$CatalogSha PRICING_SHA=$PricingSha INVENTORY_SHA=56aa4322725060b529bf316872f891582d7d1b2e"
  Push-Location $tmp
  try {
    npm run test:e2e -- apps/catalog-svc/test/postgres.persistence.e2e-spec.ts -t 'BLOCK-A2: consolidated Inventory' --disableConsoleIntercept 2>&1 | Tee-Object -Variable salida
    if ($LASTEXITCODE -ne 0) { throw "Integracion fallida: $LASTEXITCODE" }
    if (-not ($salida -match 'BLOCK_A1_INTEGRAL_HISTORY_PASS=')) { throw 'No se ejecuto el escenario historico integral.' }
  } finally { Pop-Location }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force
}
