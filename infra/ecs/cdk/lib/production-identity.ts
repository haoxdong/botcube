interface Subnet {
  id: string;
  availabilityZone: string;
}

/** The fields of the Cartridge's deploy identity the ECS app reads. */
export interface DeployIdentity {
  aws: {
    iam: { runtimeRole: string };
    account: string;
    region: string;
    agentCore: {
      runtime: string;
      runtimeNetworkParameter: string;
      sessionApiFunction: string;
      sessionApiAlias: string;
      /** The Agent Computer's own browser (ADR 0077); its profiles' names start with the prefix. */
      agentComputerBrowser: { name: string; profileNamePrefix: string };
      privateNatBrowser: {
        id: string;
        browserSecurityGroupId: string;
        extension: { bucket: string; prefix: string; versionId: string };
        subnets: Subnet[];
      };
    };
    credentialService: { vpcId: string; port: number };
    ecs: {
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
      privateEgress: { stackName: string; natGateway: { name: string; publicSubnetId: string }; routeTableId: string };
      privateNamespace: string;
      publicSubnets: Subnet[];
    };
  };
  domains: { chatService: string; chatServicePreview: string; corsOrigins: string[] };
  ssm: { parkState: string };
  product: { name: string };
  artifacts: { chatService: { reaperCommand: string[] } };
  /** The repository's immutable GitHub OIDC subject prefix (`gh api repos/<repo>/actions/oidc/customization/sub`). */
  github: { oidcSubjectPrefix: string };
}
