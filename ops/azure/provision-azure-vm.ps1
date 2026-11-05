[CmdletBinding()]
param(
  [string]$SubscriptionId,
  [string]$ResourceGroupName = 'rg-g6-productos-azure',
  [string]$VmName = 'vm-g6-backend',
  [string]$Location = 'eastus',
  [string]$VmSize = 'Standard_B1s',
  [string]$AdminUsername = 'azureuser',
  [string]$SshPublicKeyPath = "$env:USERPROFILE\.ssh\g6_cueva.pub",
  [string]$DnsLabel = ('g6-po-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

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
if ($SubscriptionId) { $accountArgs += @('--subscription', $SubscriptionId) }
$account = (& $az @accountArgs) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $account.state -ne 'Enabled') {
  throw "La suscripción de Azure no está activa o requiere 'az login'."
}

Write-Host "Suscripción activa: $($account.name) ($($account.id))"
Write-Host "Verificando disponibilidad del tamaño '$VmSize' en '$Location' (cuidando límites de Azure for Students)..."

$skus = (& $az vm list-skus --location $Location --size $VmSize --resource-type virtualMachines --output json) | ConvertFrom-Json
$availableSku = $skus | Where-Object { $_.name -eq $VmSize -and ($_.restrictions.Count -eq 0) } | Select-Object -First 1
if (-not $availableSku) {
  Write-Warning "El tamaño $VmSize tiene restricciones en $Location para esta suscripción. Probando alternativas económicas (Standard_B2ats_v2, Standard_B2pts_v2, Standard_B2s)..."
  foreach ($alt in @('Standard_B2ats_v2', 'Standard_B2s', 'Standard_B1ms')) {
    $altCheck = (& $az vm list-skus --location $Location --size $alt --resource-type virtualMachines --output json) | ConvertFrom-Json
    if ($altCheck | Where-Object { $_.name -eq $alt -and ($_.restrictions.Count -eq 0) }) {
      $VmSize = $alt
      Write-Host "Tamaño seleccionado disponible en ${Location}: $VmSize"
      break
    }
  }
}

$fqdn = "${DnsLabel}.${Location}.cloudapp.azure.com"

if ($DryRun) {
  Write-Host "[DryRun] Se crearía:"
  Write-Host "  Resource Group : $ResourceGroupName ($Location)"
  Write-Host "  VM             : $VmName ($VmSize, Ubuntu2404, StandardSSD_LRS 30GB)"
  Write-Host "  FQDN HTTPS     : https://$fqdn"
  Write-Host "  Puertos NSG    : 22, 80, 443 (puertos 3000-3008 cerrados al exterior)"
  return
}

& $az group create --name $ResourceGroupName --location $Location --output none
if ($LASTEXITCODE -ne 0) { throw "Error al crear el Resource Group $ResourceGroupName" }

$nsgName = "${VmName}-nsg"
& $az network nsg create --resource-group $ResourceGroupName --name $nsgName --location $Location --output none

foreach ($rule in @(
  @{ Name = 'Allow-SSH'; Port = 22; Priority = 1000 },
  @{ Name = 'Allow-HTTP'; Port = 80; Priority = 1010 },
  @{ Name = 'Allow-HTTPS'; Port = 443; Priority = 1020 }
)) {
  & $az network nsg rule create `
    --resource-group $ResourceGroupName `
    --nsg-name $nsgName `
    --name $rule.Name `
    --priority $rule.Priority `
    --access Allow `
    --protocol Tcp `
    --direction Inbound `
    --destination-port-ranges $rule.Port `
    --output none
}

& $az vm create `
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
