// Sanad hosted environment, Phase 1 (docs/AZURE-DEPLOYMENT-PLAN.md §5).
//
// Synthetic data only. The database is the existing Supabase project (ADR 0004);
// nothing here may hold customer data until Phase 2 and the go-live gate.
//
// Two passes, because a Container App cannot start before its image and its
// Key Vault secrets exist:
//   1. deployApps=false: registry, vault, identities, logs, Container Apps environment.
//   2. (secrets set, images built), then deployApps=true: the three apps.
// deploy/azure/README.md has the exact commands.

targetScope = 'resourceGroup'

@description('Azure region. Phase 1 is synthetic, so any region is lawful; UAE North is chosen because it offers every Phase 2 service.')
param location string = 'uaenorth'

@description('Short name used in every resource name.')
param name string = 'sanad'

@description('Image tag to run, normally the release tag on the prod branch.')
param imageTag string = 'latest'

@description('Create the three Container Apps. False on the first pass.')
param deployApps bool = false

@description('Public DNS name of the consumer app; the other apps are subdomains of it.')
param publicHost string = 'sanad.iotatechnologies.io'

@description('True once the custom domains are bound with certificates; until then each app\'s public origin is its Container Apps address.')
param customDomainsLive bool = false

@description('The Container Apps environment\'s default domain (pass 1 output environmentDefaultDomain). Fixed once the environment exists; a parameter because app definitions are evaluated before the environment\'s properties are known.')
param environmentDomain string = ''

@description('Networks allowed to reach Admin (CIDR). Admin is never open to the internet.')
param adminAllowedCidrs array

@description('Object ID of the person running the deployment; granted rights to set secrets and create the licence signing key.')
param deployerObjectId string

@description('The GitHub repository allowed to deploy, as GitHub names it in OIDC token subjects: owner@ownerId/repo@repoId (immutable IDs, so a renamed or re-created repository cannot inherit the federation). Find the IDs with `gh api repos/<owner>/<repo> --jq ".owner.id, .id"`.')
param githubOidcRepository string = 'jaffarIOTA@216283503/SANAD@1379562991'

var tags = {
  product: 'sanad'
  phase: '1-synthetic'
  dataClass: 'synthetic-only'
}

// Built-in role definition IDs (looked up with `az role definition list`).
// These are public, fixed identifiers, not credentials. kvReader is
// "Key Vault Secrets User"; kvWriter is "Key Vault Secrets Officer".
var roles = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  acrPush: '8311e382-0749-4cb8-b61a-304f252e45ec'
  kvReader: '4633458b-17de-408a-b874-0445c86b69e6'
  kvWriter: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  kvCryptoOfficer: '14b46e9e-c2b7-41b4-b07b-48a6ebf60603'
  containerAppsContributor: '358470bc-b998-42bd-ab17-a7e34c199c0f'
}

var suffix = uniqueString(resourceGroup().id)

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${name}-${suffix}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'acr${name}${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

// Premium: the licence signing key (ADR 0006) is an HSM-protected key that never leaves the vault.
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-${name}-${take(suffix, 8)}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'premium' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

// The apps' runtime identity: pulls images, reads secrets. Nothing else.
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${name}-apps'
  location: location
  tags: tags
}

// GitHub Actions deploys as this identity, by OIDC federation. No secret is stored in GitHub.
resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${name}-deploy'
  location: location
  tags: tags
}

resource deployFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployIdentity
  name: 'github-production'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubOidcRepository}:environment:production'
    audiences: ['api://AzureADTokenExchange']
  }
}

resource appAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, appIdentity.id, roles.acrPull)
  scope: registry
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
  }
}

resource appSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, appIdentity.id, roles.kvReader)
  scope: vault
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvReader)
  }
}

resource deployAcrPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, deployIdentity.id, roles.acrPush)
  scope: registry
  properties: {
    principalId: deployIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPush)
  }
}

resource deployContainerApps 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployIdentity.id, roles.containerAppsContributor)
  properties: {
    principalId: deployIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.containerAppsContributor)
  }
}

resource deployerSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, deployerObjectId, roles.kvWriter)
  scope: vault
  properties: {
    principalId: deployerObjectId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvWriter)
  }
}

resource deployerKeys 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, deployerObjectId, roles.kvCryptoOfficer)
  scope: vault
  properties: {
    principalId: deployerObjectId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvCryptoOfficer)
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${name}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

// Each app's public origin. Until the custom domains are bound, the apps answer on
// their Container Apps addresses, and the OIDC callback must return to the host
// the sign-in started from.
var origin = {
  consumer: customDomainsLive ? 'https://${publicHost}' : 'https://ca-${name}-consumer.${environmentDomain}'
  ops: customDomainsLive ? 'https://ops.${publicHost}' : 'https://ca-${name}-ops.${environmentDomain}'
  admin: customDomainsLive ? 'https://admin.${publicHost}' : 'https://ca-${name}-admin.${environmentDomain}'
}

// Staff single sign-on: one Entra ID app registration serves every tenant on this
// deployment, so every tenant's client-secret variable reads the same vault entry.
// The variable names are packages/auth/staff-oidc.ts `clientSecretVariable`.
var oidcTenants = ['BANK_A', 'FINTECH_B', 'SME_FUND_AE']
var opsOidcEnv = [for t in oidcTenants: { name: 'OIDC_CLIENT_SECRET_${t}_OPS', secretRef: 'oidc-client-secret' }]
var adminOidcEnv = [for t in oidcTenants: { name: 'OIDC_CLIENT_SECRET_${t}_ADMIN', secretRef: 'oidc-client-secret' }]

// One entry per app. Secrets are Key Vault references read by the app identity;
// no secret value passes through this template.
var apps = [
  {
    app: 'consumer'
    host: publicHost
    secrets: ['consumer-session-secret', 'sanad-database-url']
    env: [
      { name: 'CONSUMER_SESSION_SECRET', secretRef: 'consumer-session-secret' }
      { name: 'SANAD_DATABASE_URL', secretRef: 'sanad-database-url' }
      { name: 'CONSUMER_BASE_URL', value: origin.consumer }
    ]
    restricted: false
  }
  {
    app: 'ops'
    host: 'ops.${publicHost}'
    secrets: ['ops-session-secret', 'sanad-database-url', 'oidc-client-secret']
    env: concat(
      [
        { name: 'OPS_SESSION_SECRET', secretRef: 'ops-session-secret' }
        { name: 'SANAD_DATABASE_URL', secretRef: 'sanad-database-url' }
        { name: 'OPS_PUBLIC_ORIGIN', value: origin.ops }
      ],
      opsOidcEnv
    )
    restricted: false
  }
  {
    app: 'admin'
    host: 'admin.${publicHost}'
    secrets: ['admin-session-secret', 'sanad-database-url', 'oidc-client-secret']
    env: concat(
      [
        { name: 'ADMIN_SESSION_SECRET', secretRef: 'admin-session-secret' }
        { name: 'SANAD_DATABASE_URL', secretRef: 'sanad-database-url' }
        { name: 'ADMIN_PUBLIC_ORIGIN', value: origin.admin }
      ],
      adminOidcEnv
    )
    restricted: true
  }
]

// Admin answers only these networks; every other source is refused at ingress.
var adminRestrictions = [
  for (cidr, i) in adminAllowedCidrs: {
    name: 'allow-${i}'
    action: 'Allow'
    ipAddressRange: cidr
  }
]

resource containerApps 'Microsoft.App/containerApps@2024-03-01' = [
  for a in apps: if (deployApps) {
    name: 'ca-${name}-${a.app}'
    location: location
    tags: union(tags, { app: a.app })
    identity: {
      type: 'UserAssigned'
      userAssignedIdentities: { '${appIdentity.id}': {} }
    }
    properties: {
      environmentId: environment.id
      workloadProfileName: 'Consumption'
      configuration: {
        activeRevisionsMode: 'Single'
        ingress: {
          external: true
          targetPort: 3000
          transport: 'auto'
          allowInsecure: false
          ipSecurityRestrictions: a.restricted ? adminRestrictions : []
        }
        registries: [{ server: registry.properties.loginServer, identity: appIdentity.id }]
        secrets: [
          for s in a.secrets: {
            name: s
            keyVaultUrl: '${vault.properties.vaultUri}secrets/${s}'
            identity: appIdentity.id
          }
        ]
      }
      template: {
        containers: [
          {
            name: a.app
            image: '${registry.properties.loginServer}/sanad-${a.app}:${imageTag}'
            resources: { cpu: json('0.5'), memory: '1Gi' }
            env: a.env
            probes: [
              {
                type: 'Liveness'
                // Every app redirects `/` to its default locale; a 3xx counts as alive.
                httpGet: { path: '/', port: 3000 }
                initialDelaySeconds: 10
                periodSeconds: 30
              }
            ]
          }
        ]
        // One replica: some stores are still in memory (CLAUDE.md §6), so a
        // second replica would hold different state. Scale to zero when idle.
        scale: { minReplicas: 0, maxReplicas: 1 }
      }
    }
    dependsOn: [appAcrPull, appSecrets]
  }
]

output registryLoginServer string = registry.properties.loginServer
output registryName string = registry.name
output vaultName string = vault.name
output environmentName string = environment.name
output environmentDefaultDomain string = environment.properties.defaultDomain
output environmentStaticIp string = environment.properties.staticIp
output deployIdentityClientId string = deployIdentity.properties.clientId
output appHosts array = [for a in apps: { app: a.app, host: a.host, containerApp: 'ca-${name}-${a.app}' }]
