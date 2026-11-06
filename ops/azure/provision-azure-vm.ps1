[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SubscriptionId,
  [string]$ResourceGroupName = 'rg-g6-productos-azure',
  [string]$VmName = 'vm-g6-backend',
  [string]$Location = 'eastus',
  [string]$VmSize = 'Standard_B1s',
  [string]$AdminUsername = 'azureuser',
  [string]$AdminSourceCidr,
  [string]$SshPublicKeyPath = "$env:USERPROFILE\.ssh\g6_cueva.pub",
  [string]$DnsLabel = ('g6-po-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))),
  [string]$CostReviewPath,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# No implicit Internet/service-tag source, including during preflight.
$sourceParts = @($AdminSourceCidr -split '/')
$adminAddress = $null
if ([string]::IsNullOrWhiteSpace($AdminSourceCidr) -or $sourceParts.Count -gt 2 -or
    -not [Net.IPAddress]::TryParse($sourceParts[0], [ref]$adminAddress)) {
  throw 'Se requiere -AdminSourceCidr con una IP o CIDR de administración explícita.'
}
$isV4 = $adminAddress.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork
$maxPrefix = if ($isV4) { 32 } else { 128 }
if (($isV4 -and $sourceParts[0] -notmatch '^(\d{1,3}\.){3}\d{1,3}$') -or
    $sourceParts[0].Contains('%') -or $adminAddress.IsIPv4MappedToIPv6 -or
    $adminAddress.Equals([Net.IPAddress]::Any) -or $adminAddress.Equals([Net.IPAddress]::IPv6Any) -or
    ($sourceParts.Count -eq 2 -and ($sourceParts[1] -notmatch '^\d{1,3}$' -or
      [int]$sourceParts[1] -lt 1 -or [int]$sourceParts[1] -gt $maxPrefix))) {
  throw 'Origen SSH inválido: usa una IP o CIDR de administración; no se permite acceso universal (/0).'
}
$adminSource = $adminAddress.ToString() + '/' + $(if ($sourceParts.Count -eq 2) { $sourceParts[1] } else { $maxPrefix })

function Resolve-AzCli {
  $cmd = Get-Command az -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd",
    "C:\Program Files (x86)\Microsoft SDKs\Azure\CLI2\wbin\az.cmd",
    "$env:LOCALAPPDATA\Programs\Azure CLI\wbin\az.cmd"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  throw "No se encontró Azure CLI ('az'). Puedes instalarlo con: winget install -e --id Microsoft.AzureCLI --source winget"
}

$az = Resolve-AzCli
Write-Host "Usando Azure CLI: $az"

if (-not (Test-Path $SshPublicKeyPath)) {
  throw "No se encontró la clave pública SSH en: $SshPublicKeyPath"
}

$accountArgs = @('account', 'show', '--output', 'json')
$accountArgs += @('--subscription', $SubscriptionId)
$account = (& $az @accountArgs) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $account.state -ne 'Enabled') {
  throw "La suscripción de Azure no está activa o requiere 'az login'."
}

if ($account.id -ne $SubscriptionId) { throw 'La suscripción devuelta no coincide con la solicitada.' }
Write-Host "Suscripción destino: $($account.name) ($($account.id))"
Write-Host "Verificando disponibilidad del tamaño '$VmSize' en '$Location' (cuidando límites de Azure for Students)..."

$skus = (& $az vm list-skus --subscription $SubscriptionId --location $Location --size $VmSize --resource-type virtualMachines --output json) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'No se pudo consultar la disponibilidad del SKU.' }
$availableSku = $skus | Where-Object { $_.name -eq $VmSize -and ($_.restrictions.Count -eq 0) } | Select-Object -First 1
if (-not $availableSku) {
  throw "El tamaño $VmSize no está disponible en $Location. Selecciona y cotiza otro SKU; no se cambia automáticamente."
}
$usages = (& $az vm list-usage --subscription $SubscriptionId --location $Location --output json) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'No se pudieron consultar cuotas.' }
$vcpus = [int](($availableSku.capabilities | Where-Object name -eq 'vCPUs' | Select-Object -First 1).value)
if ($vcpus -lt 1 -or -not $availableSku.family) { throw 'No se pudo determinar la familia/vCPU del SKU.' }
foreach ($quotaName in @('cores', $availableSku.family)) {
  $quota = $usages | Where-Object { $_.name.value -ieq $quotaName } | Select-Object -First 1
  if (-not $quota -or ($quota.limit - $quota.currentValue) -lt $vcpus) { throw "Cuota insuficiente/no verificable: $quotaName" }
  Write-Host "Cuota ${quotaName}: $($quota.currentValue)/$($quota.limit); requiere $vcpus vCPU adicionales."
}

$fqdn = "${DnsLabel}.${Location}.cloudapp.azure.com"

if ($DryRun) {
  Write-Host "[DryRun] Se crearía:"
  Write-Host "  Resource Group : $ResourceGroupName ($Location)"
  Write-Host "  VM             : $VmName ($VmSize, Ubuntu2404, StandardSSD_LRS 30GB)"
  Write-Host "  FQDN HTTPS     : https://$fqdn"
  Write-Host "  Puertos NSG    : 22, 80, 443 (puertos 3000-3008 cerrados al exterior)"
  Write-Host "  Origen SSH     : $adminSource (HTTP/HTTPS públicos)"
  Write-Warning 'DryRun verifica SKU/cuotas; no confirma gratuidad, precio, saldo ni aprobación de despliegue.'
  return
}

if (-not $CostReviewPath -or -not (Test-Path -LiteralPath $CostReviewPath)) {
  throw 'Antes de crear recursos se requiere -CostReviewPath con la cotización real y revisión de la oferta estudiantil (ver README).'
}
$review = Get-Content -LiteralPath $CostReviewPath -Raw | ConvertFrom-Json
$reviewDate = if ($review.reviewedAt -is [DateTime]) {
  [DateTimeOffset]::new($review.reviewedAt)
} else {
  [DateTimeOffset]::Parse($review.reviewedAt, [Globalization.CultureInfo]::InvariantCulture)
}
if ($review.subscriptionId -ne $SubscriptionId -or $review.location -ne $Location -or
    $review.vmSize -ne $VmSize -or $review.storageSku -ne 'StandardSSD_LRS' -or
    $review.osDiskSizeGiB -ne 30 -or $review.offerVerified -isnot [bool] -or -not $review.offerVerified -or
    -not $review.quoteUrl -or -not $review.reviewedBy -or
    $review.monthlyUsd -isnot [ValueType] -or $review.budgetUsd -isnot [ValueType] -or
    $review.monthlyUsd -is [bool] -or $review.budgetUsd -is [bool] -or
    -not [double]::IsFinite([double]$review.monthlyUsd) -or -not [double]::IsFinite([double]$review.budgetUsd) -or
    $review.monthlyUsd -lt 0 -or $review.budgetUsd -le 0 -or $review.monthlyUsd -gt $review.budgetUsd -or
    $reviewDate -gt [DateTimeOffset]::UtcNow -or $reviewDate -lt [DateTimeOffset]::UtcNow.AddDays(-1)) {
  throw 'La revisión de costo no coincide con el plan, excede presupuesto o tiene más de 24 horas.'
}

& $az group create --subscription $SubscriptionId --name $ResourceGroupName --location $Location --output none
if ($LASTEXITCODE -ne 0) { throw "Error al crear el Resource Group $ResourceGroupName" }

$nsgName = "${VmName}-nsg"
& $az network nsg create --subscription $SubscriptionId --resource-group $ResourceGroupName --name $nsgName --location $Location --output none
if ($LASTEXITCODE -ne 0) { throw 'Error al crear NSG.' }

foreach ($rule in @(
  @{ Name = 'Allow-SSH'; Port = 22; Priority = 1000; Source = $adminSource },
  @{ Name = 'Allow-HTTP'; Port = 80; Priority = 1010; Source = '*' },
  @{ Name = 'Allow-HTTPS'; Port = 443; Priority = 1020; Source = '*' }
)) {
  & $az network nsg rule create `
    --subscription $SubscriptionId `
    --resource-group $ResourceGroupName `
    --nsg-name $nsgName `
    --name $rule.Name `
    --priority $rule.Priority `
    --access Allow `
    --protocol Tcp `
    --direction Inbound `
    --source-address-prefixes $rule.Source `
    --destination-port-ranges $rule.Port `
    --output none
  if ($LASTEXITCODE -ne 0) { throw "Error al crear regla NSG: $($rule.Name)" }
}

& $az vm create `
  --subscription $SubscriptionId `
  --resource-group $ResourceGroupName `
  --name $VmName `
  --location $Location `
  --image Ubuntu2404 `
  --size $VmSize `
  --admin-username $AdminUsername `
  --ssh-key-values $SshPublicKeyPath `
  --nsg $nsgName `
  --public-ip-sku Standard `
  --public-ip-address-dns-name $DnsLabel `
  --storage-sku StandardSSD_LRS `
  --os-disk-size-gb 30 `
  --output json

if ($LASTEXITCODE -ne 0) { throw "Error al aprovisionar la VM $VmName" }

Write-Host "=========================================================="
Write-Host "VM creada exitosamente en Azure for Students"
Write-Host "FQDN para Caddy HTTPS : $fqdn"
Write-Host "SSH                   : ssh -i ~/.ssh/g6_cueva ${AdminUsername}@${fqdn}"
Write-Host "=========================================================="
