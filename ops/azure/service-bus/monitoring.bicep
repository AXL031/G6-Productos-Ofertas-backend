targetScope = 'resourceGroup'

param namespaceName string

resource serviceBus 'Microsoft.ServiceBus/namespaces@2024-01-01' existing = {
  name: namespaceName
}

// Portal alerts only: no external recipients/actions are inferred or configured.
resource dlq 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'g6-sb-pilot-dlq'
  location: 'global'
  properties: {
    description: 'G6 pilot: inspect and classify dead letters; never automatically replay.'
    severity: 2
    enabled: true
    scopes: [serviceBus.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [{
        name: 'DeadLetters'
        metricNamespace: 'Microsoft.ServiceBus/namespaces'
        metricName: 'DeadletteredMessages'
        operator: 'GreaterThan'
        threshold: 0
        timeAggregation: 'Maximum'
        criterionType: 'StaticThresholdCriterion'
      }]
    }
    actions: []
  }
}

resource backlog 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'g6-sb-pilot-backlog'
  location: 'global'
  properties: {
    description: 'G6 pilot: active queue backlog exceeds 100. SQL-only intentions need separate SQL observation.'
    severity: 2
    enabled: true
    scopes: [serviceBus.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [{
        name: 'Backlog'
        metricNamespace: 'Microsoft.ServiceBus/namespaces'
        metricName: 'ActiveMessages'
        operator: 'GreaterThan'
        threshold: 100
        timeAggregation: 'Maximum'
        criterionType: 'StaticThresholdCriterion'
      }]
    }
    actions: []
  }
}
