interface Subnet {
  id: string;
  availabilityZone: string;
}

/** The fields of the Cartridge's deploy identity the ECS app reads. */
export interface DeployIdentity {
  aws: {
    /** `chatServiceTaskRole` names the Chat Service's task role, which the `assume-role` adapter's Memory role trusts. */
    iam: { runtimeRole: string; userMemoryRole: string; chatServiceTaskRole?: string };
    account: string;
    region: string;
    agentCore: {
      runtime: string;
      runtimeNetworkParameter: string;
      sessionApiFunction: string;
      sessionApiAlias: string;
      /** The Agent Computer's own browser (ADR 0077); its profiles' names start with the prefix. */
      agentComputerBrowser: { name: string; profileNamePrefix: string };
      /** The fixed-egress private network: its subnets hold the services and browsers; the product's login browser is `id`. */
      privateNatBrowser: { id: string; subnets: Subnet[] };
    };
    credentialService: { vpcId: string; port: number };
    ecs: {
      deployRoleName: string;
      alertsTopicName: string;
      apiHealth: { stackName: string; alarmName: string };
      webLatency: { stackName: string; appMonitorName: string };
      chatService: {
        planUsageOwnerAccountParameter: string;
        /** The private P-256 JWKs that sign per-Turn JWTs (ADR 0067 §8), created out of band. */
        turnIdentityKeysSecretName: string;
      };
      cluster: string;
      credentialService: {
        tableName: string;

        rpcPath: string;
        /** Where on the credential service BotCube tells the product of each Agent Computer browser it starts (ADR 0091). */
        agentComputerStartedPath?: string;
        /** The host the User's browser reaches the product's service on (ADR 0091). */
        publicHostname?: string;
        /** With `publicHostname`: the paths under `rpcPath` the User's browser may reach there. */
        publicPaths?: string[];
        /** With `publicHostname`: the partition-key prefixes of the Chat table rows the product's service reads and writes. */
        chatTableKeyPrefixes?: string[];
      };
      originPullCaCertificate: string;
      originPullClientSecretName: string;
      originTokenSecretName: string;
      parkedDnsTarget: string;
      previewOriginStackName: string;
      originOwnership: string;
      parkedWorkerName: string;
      parking: { repository: string; appSecretName: string; slotBucket: string; originSlotKey: string; functionName: string; automationUserAgents: string[]; autoPark: boolean };
      originZone: string;
      /** The NAT BotCube creates and parks for the private subnets; absent, an existing network brings its own egress. */
      privateEgress?: { stackName: string; natGateway: { name: string; publicSubnetId: string }; routeTableId: string };
      privateNamespace: string;
      publicSubnets: Subnet[];
    };
  };
  domains: { chatService: string; chatServicePreview: string; rawServiceOrigins?: string[]; corsOrigins: string[] };
  ssm: { parkState: string };
  product: { name: string };
  /** The repository's immutable GitHub OIDC subject prefix (`gh api repos/<repo>/actions/oidc/customization/sub`). */
  github: { oidcSubjectPrefix: string };
}
