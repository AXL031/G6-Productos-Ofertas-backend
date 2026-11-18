targetScope = 'resourceGroup'

type Flow = 'R01' | 'R02' | 'R03' | 'R04' | 'R05' | 'R06' | 'R07' | 'R08' | 'R09' | 'R10' | 'R11' | 'R12' | 'R13' | 'R14' | 'R15' | 'R16' | 'R17' | 'R18' | 'N01'

@description('Explicitly selected H5 flows for a dedicated integration resource group.')
@minLength(1)
param flows Flow[]

param location string = resourceGroup().location

var routes = {
  R01: { from: 'bulk', to: 'catalog', queue: 'g6.catalog.from.bulk' }
  R02: { from: 'bulk', to: 'inventory', queue: 'g6.inventory.from.bulk' }
  R03: { from: 'bulk', to: 'pricing', queue: 'g6.pricing.from.bulk' }
  R04: { from: 'catalog', to: 'bulk', queue: 'g6.bulk.from.catalog' }
  R05: { from: 'catalog', to: 'combos', queue: 'g6.combos.from.catalog' }
  R06: { from: 'catalog', to: 'inventory', queue: 'g6.inventory.from.catalog' }
  R07: { from: 'catalog', to: 'pricing', queue: 'g6.pricing.from.catalog' }
  R08: { from: 'catalog', to: 'promotions', queue: 'g6.promotions.from.catalog' }
  R09: { from: 'catalog', to: 'taxonomy', queue: 'g6.taxonomy.from.catalog' }
  R10: { from: 'inventory', to: 'bulk', queue: 'g6.bulk.from.inventory' }
  R11: { from: 'inventory', to: 'catalog', queue: 'g6.catalog.from.inventory' }
  R12: { from: 'inventory', to: 'combos', queue: 'g6.combos.from.inventory' }
  R13: { from: 'inventory', to: 'promotions', queue: 'g6.promotions.from.inventory' }
  R14: { from: 'pricing', to: 'bulk', queue: 'g6.bulk.from.pricing' }
  R15: { from: 'pricing', to: 'catalog', queue: 'g6.catalog.from.pricing' }
  R16: { from: 'pricing', to: 'price-audit', queue: 'g6.price-audit.from.pricing' }
  R17: { from: 'pricing', to: 'promotions', queue: 'g6.promotions.from.pricing' }
  R18: { from: 'taxonomy', to: 'catalog', queue: 'g6.catalog.from.taxonomy' }
  N01: { from: 'promotions', to: 'promotions', queue: 'g6.promotions.commands' }
}
var selectedFlows = union(flows, [])
var selected = map(selectedFlows, id => routes[id])
var services = union(map(selected, route => route.from), map(selected, route => route.to))
var namespaceName = 'g6-sb-h5-int-${uniqueString(resourceGroup().id)}'
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
    disableLocalAuth: true
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for service in services: {
  name: 'g6-h5-int-${service}'
  location: location
}]

resource queues 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = [for route in selected: {
  parent: serviceBus
  name: route.queue
  properties: {
    lockDuration: 'PT1M'
    maxDeliveryCount: 10
    maxSizeInMegabytes: 1024
    deadLetteringOnMessageExpiration: true
  }
}]

resource senders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (route, i) in selected: {
  name: guid(queues[i].id, identity[indexOf(services, route.from)].id, senderRole)
  scope: queues[i]
  properties: {
    principalId: identity[indexOf(services, route.from)].properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: senderRole
  }
}]

resource receivers 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (route, i) in selected: {
  name: guid(queues[i].id, identity[indexOf(services, route.to)].id, receiverRole)
  scope: queues[i]
  properties: {
    principalId: identity[indexOf(services, route.to)].properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: receiverRole
  }
}]

var thresholds = [
  { name: 'dlq', metric: 'DeadletteredMessages', threshold: 0, severity: 2 }
  { name: 'backlog', metric: 'ActiveMessages', threshold: 100, severity: 3 }
]
resource alerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [for threshold in thresholds: {
  name: '${namespaceName}-${threshold.name}'
  location: 'global'
  properties: {
    description: 'G6 H5 integration Service Bus ${threshold.name}'
    severity: threshold.severity
    enabled: true
    scopes: [serviceBus.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [{
        criterionType: 'StaticThresholdCriterion'
        name: threshold.name
        metricNamespace: 'Microsoft.ServiceBus/namespaces'
        metricName: threshold.metric
        operator: 'GreaterThan'
        threshold: threshold.threshold
        timeAggregation: 'Maximum'
      }]
    }
    actions: []
  }
}]

output namespaceFqdn string = '${serviceBus.name}.servicebus.windows.net'
output queueNames array = map(selected, route => route.queue)
output workloadIdentities array = [for (service, i) in services: {
  service: service
  resourceId: identity[i].id
  clientId: identity[i].properties.clientId
}]
