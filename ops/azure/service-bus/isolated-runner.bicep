targetScope = 'resourceGroup'

param location string = resourceGroup().location
param containerGroupName string = 'aci-g6-sb-pilot'
param namespaceFqdn string
param pricingIdentityId string
param auditIdentityId string
param pricingClientId string
param auditClientId string
param bundleSha256 string
@secure()
param bundle object
param bootstrapCode string
@secure()
param pricingTestPassword string
@secure()
param auditTestPassword string
param cleanupManifest string = ''

var statusVolume = [{ name: 'status', mountPath: '/pilot-status' }]
var bundleEnvironment = [for (chunk, i) in bundle.chunks: {
  name: 'G6_BUNDLE_${padLeft(i, 3, '0')}'
  secureValue: chunk
}]
var postgresImage = 'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
var pgCommand = 'while [ ! -f /pilot-status/tls-ready ]; do if [ -f /pilot-status/done ]; then exit 0; fi; sleep 1; done; timeout -s TERM 900 /usr/local/bin/docker-entrypoint.sh postgres -p "$PGPORT" -c listen_addresses=127.0.0.1 -c ssl=on -c ssl_cert_file=/pilot-status/tls/server.crt -c ssl_key_file=/pilot-status/tls/server.key & server=$!; while kill -0 "$server" 2>/dev/null; do if [ -f /pilot-status/done ]; then kill -TERM "$server"; break; fi; sleep 2; done; wait "$server"; exit 0'

resource runner 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = {
  name: containerGroupName
  location: location
  tags: { purpose: 'g6-service-bus-isolated-test', sourceBundleSha256: bundleSha256, production: 'false' }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pricingIdentityId}': {}
      '${auditIdentityId}': {}
    }
  }
  properties: {
    osType: 'Linux'
    restartPolicy: 'Never'
    volumes: [{ name: 'status', emptyDir: {} }]
    containers: [
      {
        name: 'runner'
        properties: {
          image: 'node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f'
          command: ['/bin/sh', '-c', 'timeout -s TERM 900 node -e "$G6_BOOTSTRAP"; touch /pilot-status/done; exit 0']
          resources: { requests: { cpu: 1, memoryInGB: 1 } }
          volumeMounts: statusVolume
          environmentVariables: concat([
            { name: 'G6_BOOTSTRAP', value: bootstrapCode }
            { name: 'BUNDLE_SHA256', value: bundleSha256 }
            { name: 'G6_SERVICE_BUS_TEST_NAMESPACE', value: namespaceFqdn }
            { name: 'G6_PRICING_TEST_CLIENT_ID', value: pricingClientId }
            { name: 'G6_AUDIT_TEST_CLIENT_ID', value: auditClientId }
            { name: 'PRICING_TEST_PASSWORD', secureValue: pricingTestPassword }
            { name: 'AUDIT_TEST_PASSWORD', secureValue: auditTestPassword }
            { name: 'G6_TEST_DLQ_CLEANUP_MANIFEST', value: cleanupManifest }
          ], bundleEnvironment)
        }
      }
      {
        name: 'pricing-postgres'
        properties: {
          image: postgresImage
          command: ['/bin/sh', '-c', pgCommand]
          resources: { requests: { cpu: json('0.5'), memoryInGB: json('0.5') } }
          volumeMounts: statusVolume
          environmentVariables: [
            { name: 'POSTGRES_PASSWORD', secureValue: pricingTestPassword }
            { name: 'POSTGRES_DB', value: 'pricing_test' }
            { name: 'PGPORT', value: '5432' }
          ]
        }
      }
      {
        name: 'audit-postgres'
        properties: {
          image: postgresImage
          command: ['/bin/sh', '-c', pgCommand]
          resources: { requests: { cpu: json('0.5'), memoryInGB: json('0.5') } }
          volumeMounts: statusVolume
          environmentVariables: [
            { name: 'POSTGRES_PASSWORD', secureValue: auditTestPassword }
            { name: 'POSTGRES_DB', value: 'price_audit_test' }
            { name: 'PGPORT', value: '5433' }
          ]
        }
      }
    ]
  }
}

output containerGroupId string = runner.id
