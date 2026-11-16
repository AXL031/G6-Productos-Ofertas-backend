targetScope = 'resourceGroup'

@minLength(6)
@maxLength(50)
param namespaceName string
param location string
@description('Object ID of the pre-existing Pricing workload identity, never its client secret.')
param pricingPrincipalId string
@description('Object ID of a different pre-existing Audit workload identity.')
param auditPrincipalId string
@minValue(1)
@maxValue(100)
param maxDeliveryCount int = 10

var queueName = 'g6.price-audit.from.pricing'
var senderRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39')
var receiverRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0')

resource serviceBus 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: namespaceName
  location: location
  sku: {
    name: 'Basic'
    tier: 'Basic'
  }
  properties: {
    minimumTlsVersion: '1.2'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource pilotQueue 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = {
  parent: serviceBus
  name: queueName
  properties: {
    lockDuration: 'PT1M'
    maxDeliveryCount: maxDeliveryCount
    maxSizeInMegabytes: 1024
  }
}

resource pricingSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(pilotQueue.id, pricingPrincipalId, senderRole)
  scope: pilotQueue
  properties: {
    principalId: pricingPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: senderRole
  }
}

resource auditReceiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(pilotQueue.id, auditPrincipalId, receiverRole)
  scope: pilotQueue
  properties: {
    principalId: auditPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: receiverRole
  }
}

output namespaceFqdn string = '${serviceBus.name}.servicebus.windows.net'
output queueResourceId string = pilotQueue.id
