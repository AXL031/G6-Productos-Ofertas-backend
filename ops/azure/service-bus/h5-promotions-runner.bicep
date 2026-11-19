targetScope = 'resourceGroup'

param location string = resourceGroup().location
param containerGroupName string
param namespaceFqdn string
param inventoryIdentityId string
param inventoryClientId string
param promotionsIdentityId string
param promotionsClientId string
param inventoryImage string
param promotionsImage string
param catalogIdentityId string = ''
param catalogClientId string = ''
param catalogImage string = ''
@minLength(40)
@maxLength(40)
param sourceSha string
@minLength(64)
@maxLength(64)
param sourceArchiveSha256 string
@secure()
param postgresPassword string

var database = 'g6_promotions_h5_test_r13'
var mount = [{ name: 'status', mountPath: '/status' }]
var runner = loadTextContent('h5-promotions-runner.sh')
var runR08 = !empty(catalogIdentityId) && !empty(catalogClientId) && !empty(catalogImage)
var publishedImages = [
  { service: 'inventory-svc', image: inventoryImage }
  { service: 'promotions-svc', image: promotionsImage }
]
var selectedImages = concat(publishedImages, runR08 ? [{ service: 'catalog-svc', image: catalogImage }] : [])
var stageCommand = '''
set -eu
destination="/status/artifacts/$G6_SERVICE"
i=0
until [ -w "$destination" ]; do
  [ "$i" -lt 60 ] || exit 1
  sleep 1
  i=$((i + 1))
done
cp -R "/app/dist/apps/$G6_SERVICE/." "$destination/"
touch "$destination/ready"
printf 'PUBLISHED_SERVICE_STAGED %s\n' "$G6_SERVICE"
'''
var postgresCommand = '''
timeout -s TERM 600 /usr/local/bin/docker-entrypoint.sh postgres -c listen_addresses=127.0.0.1 &
pg=$!
while kill -0 "$pg" 2>/dev/null; do
  if [ -f /status/done ]; then kill -TERM "$pg"; break; fi
  sleep 2
done
wait "$pg"
'''
var artifactContainers = [for workload in selectedImages: {
  name: workload.service
  properties: {
    image: workload.image
    command: ['/bin/sh', '-c', stageCommand]
    resources: { requests: { cpu: json('0.5'), memoryInGB: json('0.5') } }
    volumeMounts: mount
    environmentVariables: [{ name: 'G6_SERVICE', value: workload.service }]
  }
}]

resource group 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = {
  name: containerGroupName
  location: location
  tags: {
    purpose: 'g6-h5-fork-promotions'
    sourceSha: sourceSha
    production: 'false'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: union({
      '${inventoryIdentityId}': {}
      '${promotionsIdentityId}': {}
    }, runR08 ? { '${catalogIdentityId}': {} } : {})
  }
  properties: {
    osType: 'Linux'
    restartPolicy: 'Never'
    volumes: [{ name: 'status', emptyDir: {} }]
    containers: concat([
      {
        name: 'runner'
        properties: {
          image: 'node:24.15.0-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f'
          command: ['/bin/sh', '-c', 'timeout -s TERM 540 /bin/sh -c "$G6_PROMOTIONS_RUNNER"; result=$?; touch /status/done; exit "$result"']
          resources: { requests: { cpu: 1, memoryInGB: 2 } }
          volumeMounts: mount
          environmentVariables: [
            { name: 'G6_PROMOTIONS_RUNNER', value: runner }
            { name: 'G6_SOURCE_SHA', value: sourceSha }
            { name: 'G6_SOURCE_ARCHIVE_SHA256', value: sourceArchiveSha256 }
            { name: 'G6_H5_R13_REAL_AZURE', value: '1' }
            { name: 'G6_H5_R08_REAL_AZURE', value: runR08 ? '1' : '0' }
            { name: 'G6_H5_LAB_NAMESPACE_FQDN', value: namespaceFqdn }
            { name: 'G6_H5_LAB_INVENTORY_CLIENT_ID', value: inventoryClientId }
            { name: 'G6_H5_LAB_PROMOTIONS_CLIENT_ID', value: promotionsClientId }
            { name: 'G6_H5_LAB_CATALOG_CLIENT_ID', value: catalogClientId }
            { name: 'PROMOTIONS_H5_POSTGRES_TESTS', value: '1' }
            { name: 'G6_H5_POSTGRES_DATABASE', value: database }
            { name: 'G6_H5_POSTGRES_PASSWORD', secureValue: postgresPassword }
          ]
        }
      }
      {
        name: 'postgres'
        properties: {
          image: 'postgres:17-alpine@sha256:526f86d93c6ea08fd3f1fe5605650cacc781b2c6013169a0ad8f42c7d3d84f32'
          command: ['/bin/sh', '-c', postgresCommand]
          resources: { requests: { cpu: json('0.5'), memoryInGB: 1 } }
          volumeMounts: mount
          environmentVariables: [
            { name: 'POSTGRES_DB', value: database }
            { name: 'POSTGRES_PASSWORD', secureValue: postgresPassword }
          ]
        }
      }
    ], artifactContainers)
  }
}
