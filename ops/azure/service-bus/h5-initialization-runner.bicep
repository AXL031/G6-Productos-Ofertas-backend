targetScope = 'resourceGroup'

type Workload = {
  service: 'catalog-svc' | 'inventory-svc' | 'pricing-svc' | 'taxonomy-svc'
  image: string
  identityId: string
  clientId: string
}

param containerGroupName string
param namespaceFqdn string
@minLength(3)
@maxLength(4)
param workloads Workload[]
@minLength(40)
@maxLength(40)
param sourceSha string
@minLength(64)
@maxLength(64)
param archiveSha256 string
@secure()
param postgresPassword string

var database = 'g6_init_h5_test_azure'
var statusMount = [{ name: 'status', mountPath: '/status' }]
var runner = loadTextContent('h5-initialization-runner.sh')
var identityKeys = toObject(workloads, workload => workload.identityId, workload => {})
var stage = '''
set -eu
target="/status/artifacts/$SERVICE"
for i in $(seq 1 60); do
  if [ -w "$target" ]; then
    cp -R "/app/dist/apps/$SERVICE/." "$target/"
    touch "$target/ready"
    printf 'PUBLISHED_SERVICE_STAGED %s\n' "$SERVICE"
    exit 0
  fi
  sleep 1
done
exit 1
'''
var postgres = '''
timeout -s TERM 600 /usr/local/bin/docker-entrypoint.sh postgres -c listen_addresses=127.0.0.1 &
pg=$!
while kill -0 "$pg" 2>/dev/null; do
  if [ -f /status/done ]; then kill -TERM "$pg"; break; fi
  sleep 2
done
wait "$pg"
'''
var containers = [for workload in workloads: {
  name: workload.service
  properties: {
    image: workload.image
    command: ['/bin/sh', '-c', stage]
    resources: { requests: { cpu: json('0.5'), memoryInGB: json('0.5') } }
    volumeMounts: statusMount
    environmentVariables: [{ name: 'SERVICE', value: workload.service }]
  }
}]
var identities = [for workload in workloads: {
  name: 'G6_H5_LAB_${toUpper(replace(workload.service, '-svc', ''))}_CLIENT_ID'
  value: workload.clientId
}]

resource group 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = {
  name: containerGroupName
  location: resourceGroup().location
  tags: { purpose: 'g6-h5-fork-initialization', sourceSha: sourceSha, production: 'false' }
  identity: { type: 'UserAssigned', userAssignedIdentities: identityKeys }
  properties: {
    osType: 'Linux'
    restartPolicy: 'Never'
    volumes: [{ name: 'status', emptyDir: {} }]
    containers: concat(containers, [
      {
        name: 'runner'
        properties: {
          image: 'node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f'
          command: ['/bin/sh', '-c', 'timeout -s TERM 540 /bin/sh -c "$LAB_RUNNER"; result=$?; touch /status/done; exit "$result"']
          resources: { requests: { cpu: 1, memoryInGB: 2 } }
          volumeMounts: statusMount
          environmentVariables: concat(identities, [
            { name: 'LAB_RUNNER', value: runner }
            { name: 'G6_SOURCE_SHA', value: sourceSha }
            { name: 'G6_SOURCE_ARCHIVE_SHA256', value: archiveSha256 }
            { name: 'G6_H5_LAB_NAMESPACE_FQDN', value: namespaceFqdn }
            { name: 'G6_H5_POSTGRES_DATABASE', value: database }
            { name: 'G6_H5_POSTGRES_PASSWORD', secureValue: postgresPassword }
          ])
        }
      }
      {
        name: 'postgres'
        properties: {
          image: 'postgres:17-alpine@sha256:526f86d93c6ea08fd3f1fe5605650cacc781b2c6013169a0ad8f42c7d3d84f32'
          command: ['/bin/sh', '-c', postgres]
          resources: { requests: { cpu: json('0.5'), memoryInGB: 1 } }
          volumeMounts: statusMount
          environmentVariables: [
            { name: 'POSTGRES_DB', value: database }
            { name: 'POSTGRES_PASSWORD', secureValue: postgresPassword }
          ]
        }
      }
    ])
  }
}
