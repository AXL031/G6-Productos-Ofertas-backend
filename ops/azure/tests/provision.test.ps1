$ErrorActionPreference = 'Stop'
# Offline execution of the actual script with only the CLI resolver substituted.
# Mock-AzureCli never calls az or creates cloud resources.
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../provision-azure-vm.ps1') -Raw
$source = $source.Replace('$az = Resolve-AzCli', '$az = ''Mock-AzureCli''')
$runner = [scriptblock]::Create($source)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('g6-azure-preflight-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$key = Join-Path $testRoot 'fixture.pub'
$reviewPath = Join-Path $testRoot 'review.json'
Set-Content -LiteralPath $key -Value 'ssh-ed25519 fixture-only'
$script:calls = @()
$script:restrictedSku = $false
$script:quotaLimit = 10
$script:failNsg = $false

function Mock-AzureCli {
  $script:calls += ,@($args)
  $global:LASTEXITCODE = 0
  if ($args[0] -eq 'account') { return '{"id":"student-fixture","name":"Azure for Students","state":"Enabled"}' }
  if ($args[0] -eq 'vm' -and $args[1] -eq 'list-skus') {
    $restrictions = if ($script:restrictedSku) { @(@{ reasonCode = 'NotAvailableForSubscription' }) } else { @() }
    return ConvertTo-Json -Depth 5 -InputObject @(@{ name = 'Standard_B1s'; family = 'standardBSFamily'; restrictions = $restrictions; capabilities = @(@{ name = 'vCPUs'; value = '1' }) })
  }
  if ($args[0] -eq 'vm' -and $args[1] -eq 'list-usage') {
    return ConvertTo-Json -Depth 4 -InputObject @(
      @{ name = @{ value = 'cores' }; limit = $script:quotaLimit; currentValue = 0 },
      @{ name = @{ value = 'standardBSFamily' }; limit = $script:quotaLimit; currentValue = 0 })
  }
  if ($script:failNsg -and $args[0] -eq 'network' -and $args[2] -eq 'create') { $global:LASTEXITCODE = 1 }
}
function Assert-That([bool]$condition, [string]$message) {
  if (-not $condition) { throw "FAIL: $message" }
}
function Assert-Throws([scriptblock]$action, [string]$message) {
  $threw = $false
  try { & $action } catch { $threw = $true }
  Assert-That $threw $message
}
function Has-Creation { return @($script:calls | Where-Object { $_ -contains 'create' }).Count -gt 0 }
$common = @{ SubscriptionId = 'student-fixture'; SshPublicKeyPath = $key; AdminSourceCidr = '203.0.113.10/32' }
$sourceScenarios = 0
try {
  & $runner @common -DryRun
  Assert-That (-not (Has-Creation)) 'DryRun must never create resources'
  Assert-That ($script:calls.Count -eq 3) 'DryRun must verify account, SKU and quotas'
  $script:calls = @()
  Assert-Throws { & $runner @common } 'cost review must precede creation'
  Assert-That (-not (Has-Creation)) 'missing cost review must not create resources'
  $script:calls = @(); $script:restrictedSku = $true
  Assert-Throws { & $runner @common -DryRun } 'unavailable SKU must fail without a fallback'
  Assert-That (-not (Has-Creation)) 'unavailable SKU must not create resources'
  $script:restrictedSku = $false; $script:quotaLimit = 0; $script:calls = @()
  Assert-Throws { & $runner @common -DryRun } 'insufficient quota must fail'
  $script:quotaLimit = 10
  $review = @{ subscriptionId = 'student-fixture'; location = 'eastus'; vmSize = 'Standard_B1s';
    storageSku = 'StandardSSD_LRS'; osDiskSizeGiB = 30; reviewedAt = [DateTimeOffset]::UtcNow.ToString('o');
    offerVerified = $true; quoteUrl = 'https://azure.microsoft.com/fixture-only'; reviewedBy = 'fixture'; monthlyUsd = 10; budgetUsd = 15 }
  $review | ConvertTo-Json | Set-Content -LiteralPath $reviewPath
  $script:calls = @()
  & $runner @common -CostReviewPath $reviewPath
  Assert-That (Has-Creation) 'valid reviewed plan should reach the mocked creation calls'
  foreach ($call in $script:calls) {
    $index = [Array]::IndexOf($call, '--subscription')
    Assert-That ($index -ge 0 -and $call[$index + 1] -eq 'student-fixture') 'every CLI call must target the requested subscription'
  }
  function Assert-NsgSources([string]$expectedSource) {
    $rules = @($script:calls | Where-Object { $_[0] -eq 'network' -and $_[2] -eq 'rule' -and $_[3] -eq 'create' })
    Assert-That ($rules.Count -eq 3) 'must create exactly SSH, HTTP and HTTPS rules'
    foreach ($rule in $rules) {
      $nameIndex = [Array]::IndexOf($rule, '--name')
      $sourceIndex = [Array]::IndexOf($rule, '--source-address-prefixes')
      $expected = if ($rule[$nameIndex + 1] -eq 'Allow-SSH') { $expectedSource } else { '*' }
      Assert-That ($sourceIndex -ge 0 -and $rule[$sourceIndex + 1] -eq $expected) 'SSH must be restricted; HTTP/HTTPS remain public'
    }
  }
  Assert-NsgSources '203.0.113.10/32'
  $sourceScenarios++
  foreach ($validSource in @(
    @{ Input = '203.0.113.10'; Expected = '203.0.113.10/32' },
    @{ Input = '203.0.113.0/24'; Expected = '203.0.113.0/24' },
    @{ Input = '2001:db8::10'; Expected = '2001:db8::10/128' },
    @{ Input = '2001:db8::/64'; Expected = '2001:db8::/64' }
  )) {
    $settings = $common.Clone(); $settings.AdminSourceCidr = $validSource.Input
    $script:calls = @()
    & $runner @settings -CostReviewPath $reviewPath
    Assert-NsgSources $validSource.Expected
    $sourceScenarios++
  }
  foreach ($invalidSource in @('', '*', 'Internet', '0.0.0.0/0', '::/0', '0.0.0.0', '::',
    '203.0.113.10/33', '2001:db8::/129', '203.0.113.10/-1', '203.0.113.10/',
    '203.0.113.10/32/1', '999.0.0.1', '127.1', '2130706433', '::ffff:203.0.113.10', 'fe80::1%3')) {
    $settings = $common.Clone(); $settings.AdminSourceCidr = $invalidSource
    $script:calls = @()
    Assert-Throws { & $runner @settings -CostReviewPath $reviewPath } "invalid SSH source '$invalidSource' must fail"
    Assert-That ($script:calls.Count -eq 0) 'invalid source must fail before contacting Azure'
    $sourceScenarios++
  }
  $settings = $common.Clone(); $settings.Remove('AdminSourceCidr')
  $script:calls = @()
  Assert-Throws { & $runner @settings -DryRun } 'missing SSH source must fail even in DryRun'
  Assert-That ($script:calls.Count -eq 0) 'missing source must fail before contacting Azure'
  $sourceScenarios++
  foreach ($field in @('monthlyUsd', 'subscriptionId', 'reviewedAt')) {
    $changed = $review.Clone()
    $changed[$field] = switch ($field) { 'monthlyUsd' { 100 }; 'subscriptionId' { 'another-subscription' }; 'reviewedAt' { [DateTimeOffset]::UtcNow.AddDays(-2).ToString('o') } }
    $changed | ConvertTo-Json | Set-Content -LiteralPath $reviewPath
    $script:calls = @()
    Assert-Throws { & $runner @common -CostReviewPath $reviewPath } "invalid review field $field must fail"
    Assert-That (-not (Has-Creation)) 'invalid cost review must not create resources'
  }
  $review | ConvertTo-Json | Set-Content -LiteralPath $reviewPath
  $script:calls = @(); $script:failNsg = $true
  Assert-Throws { & $runner @common -CostReviewPath $reviewPath } 'NSG failure must stop before VM creation'
  Assert-That (@($script:calls | Where-Object { $_[0] -eq 'vm' -and $_[1] -eq 'create' }).Count -eq 0) 'VM must not follow NSG failure'
  Write-Output "PASS: 9 cost/quota scenarios + $sourceScenarios SSH-source scenarios; no Azure resources contacted."
  $global:LASTEXITCODE = 0
} finally {
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (-not $resolvedTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path' }
  Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}
