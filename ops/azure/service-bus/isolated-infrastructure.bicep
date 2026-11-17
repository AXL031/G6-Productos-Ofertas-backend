targetScope = 'resourceGroup'

param location string = resourceGroup().location
param namespaceName string

resource pricingIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-g6-sb-pilot-pricing'
  location: location
}

resource auditIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-g6-sb-pilot-audit'
  location: location
}

module messaging 'main.bicep' = {
  name: 'messaging'
  params: {
    namespaceName: namespaceName
    location: location
    pricingPrincipalId: pricingIdentity.properties.principalId
    auditPrincipalId: auditIdentity.properties.principalId
  }
}

output namespaceFqdn string = messaging.outputs.namespaceFqdn
output queueResourceId string = messaging.outputs.queueResourceId
output pricingIdentityId string = pricingIdentity.id
output auditIdentityId string = auditIdentity.id
output pricingClientId string = pricingIdentity.properties.clientId
output auditClientId string = auditIdentity.properties.clientId
