/** A physical-name template filled from a deployment's `name`: `{name}` is it, `{snake}` it with `_` for `-`, `{compact}` it without `-`. */
function fillName(template, name) {
  return template.replaceAll('{name}', name).replaceAll('{snake}', name.replaceAll('-', '_')).replaceAll('{compact}', name.replaceAll('-', ''));
}

const DERIVED_NAMES = {
  runtimeAgentRuntimeName: '{snake}_runtime',
  memoryName: '{snake}_memory',
  agentComputerBrowserName: '{snake}_agent_computer_managed',
  agentComputerBrowserProfileNamePrefix: '{snake}_',
  linkBrowserName: '{snake}_link',
  agentCoreTargetName: 'default',
  sessionApiFunctionName: '{name}-session-api',
  clusterName: '{name}',
  deployRoleName: '{name}-ecs-github-deploy',
  deployPolicyName: '{name}-ecs-deploy',
  previewOriginStackName: '{name}-preview-origin',
  privateEgressStackName: '{name}-private-egress',
  natGatewayName: '{name}-private-egress',
  apiHealthStackName: '{name}-api-health',
  apiHealthAlarmName: '{name}-api-health',
  webLatencyStackName: '{name}-web-latency',
  webAppMonitorName: '{name}-web',
  alertsTopicName: '{name}-alerts',
  parkingFunctionName: '{name}-production-parking',
  repositoryName: '{name}/runtime',
  buildProjectName: '{name}-container-builder',
  buildFunctionName: '{name}-container-build-handler',
  buildLogGroupName: '/aws/lambda/{name}-container-build-handler',
  deployUserName: '{name}-deploy',
  runtimeRoleName: '{name}-runtime',
  memoryRoleName: '{name}-memory',
  userMemoryRoleName: '{name}-user-memory',
  chatServiceTaskRoleName: null,
  filesMountRoleName: null,
  filesLinksRoleName: null,
  agentComputerBrowserRoleName: null,
  buildFunctionRoleName: '{name}-container-build-handler',
  buildRoleName: '{name}-container-build',
  sessionApiRoleName: '{name}-session-api',
  invokePolicyNamePrefix: '{name}-agentcore-invoke',
  runtimeAlarmNamePrefix: '{name}-runtime',
  runtimeErrorsFilterName: '{name}-runtime-error-lines',
};

const FIXED_NAMES = {
  parkStateParameterName: '/{name}/production/park-state',
  originPullClientSecretName: '/{name}/cloudflare/origin-pull-client',
  originTokenSecretName: '/{name}/cloudflare/origin-api-token',
  turnIdentityKeysSecretName: '/{name}/chat-service/turn-identity-keys',
  rollbackTaskFamilyPrefix: '{name}-preview-rollback-',
  rollbackPolicyName: '{name}-preview-rollback',
};

function deploymentNames(config) {
  const names = Object.fromEntries(Object.entries(DERIVED_NAMES).flatMap(([key, template]) => {
    const value = config.names?.[key] ?? (template === null ? undefined : fillName(template, config.name));
    return value === undefined ? [] : [[key, value]];
  }));
  const fixed = Object.fromEntries(Object.entries(FIXED_NAMES).map(([key, template]) => [key, fillName(template, config.name)]));
  return { ...names, ...fixed };
}

module.exports = { fillName, DERIVED_NAMES, deploymentNames };
