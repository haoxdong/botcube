#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="${BOTCUBE_DEPLOY_ROOT:?BOTCUBE_DEPLOY_ROOT must point to the active deploy directory}"
# The GitHub OIDC subject of the workflow that deploys: the release tooling's, which no BotCube Config holds.
OIDC_SUBJECT="${GITHUB_OIDC_SUBJECT:?GITHUB_OIDC_SUBJECT must name the OIDC subject of the workflow that deploys}"

if [[ "${1:-}" == '--profile' ]]; then
  test -n "${2:-}"
  export AWS_PROFILE="$2"
  shift 2
fi
if [[ "$#" -ne 0 ]]; then
  echo 'usage: bootstrap-deploy-role.sh [--profile AWS_PROFILE]' >&2
  exit 2
fi

read -r AWS_ACCOUNT_ID AWS_REGION STACK_FAMILY CLUSTER ROLE_NAME ORIGIN_PULL_SECRET ORIGIN_TOKEN_SECRET ALERTS_TOPIC MEMORY_NAME PARK_STATE POLICY_NAME PARKING_FUNCTION SESSION_API RUNTIME_ROLE EGRESS_STACK ORIGIN_STACK HEALTH_STACK TURN_IDENTITY_SECRET < <(node -e '
  const config = require(require("node:path").resolve(process.argv[1])).readDeployment(process.argv[2]);
  const names = require(require("node:path").resolve(process.argv[1])).deploymentNames(config);
  process.stdout.write([
    config.env.account,
    config.env.region,
    config.name,
    names.clusterName,
    names.deployRoleName,
    names.originPullClientSecretName,
    names.originTokenSecretName,
    names.alertsTopicName,
    names.memoryName,
    names.parkStateParameterName,
    names.deployPolicyName,
    names.parkingFunctionName,
    names.sessionApiFunctionName,
    names.runtimeRoleName,
    names.privateEgressStackName,
    names.previewOriginStackName,
    names.apiHealthStackName,
    names.turnIdentityKeysSecretName,
  ].join(" ") + "\n");
' "$(dirname "${BASH_SOURCE[0]}")/../../config/read.cjs" "$DEPLOY_ROOT")

TRUST_POLICY="$(mktemp)"
ROLE_POLICY="$(mktemp)"
trap 'rm -f "$TRUST_POLICY" "$ROLE_POLICY"' EXIT

# The repository uses GitHub's immutable OIDC subject, `repo:<owner>@<owner id>/<repo>@<repo id>`
# so a repository rename keeps the configured subject valid.
cat > "$TRUST_POLICY" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::$AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "$OIDC_SUBJECT"
      }
    }
  }]
}
EOF

# Like the Credential Service role, effective deploy privilege comes from the CDK
# bootstrap roles: they publish image assets (the asset repository has immutable
# tags) and CloudFormation applies changes as cfn-exec-role. The direct grants
# cover the guarded change-set flow, rollout checks and the Cloudflare upload of
# the origin pull client certificate. ECS migration tickets widen this as needed.
cat > "$ROLE_POLICY" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
{
  "Effect": "Allow",
  "Action": [
    "ecs:ListClusters",
    "ecs:ListServices",
    "ecs:ListTasks",
    "ecs:ListTaskDefinitionFamilies",
    "ecs:DescribeTaskDefinition",
    "ecs:DescribeServices",
    "ecs:DescribeTasks",
    "lambda:ListFunctions",
    "lambda:ListAliases",
    "lambda:GetFunction",
    "bedrock-agentcore:ListAgentRuntimes",
    "bedrock-agentcore:ListAgentRuntimeEndpoints",
    "bedrock-agentcore:GetAgentRuntime",
    "ecr:CreateRepository",
    "ecr:GetAuthorizationToken",
    "ecr:BatchCheckLayerAvailability",
    "ecr:InitiateLayerUpload",
    "ecr:UploadLayerPart",
    "ecr:CompleteLayerUpload",
    "ecr:DescribeRepositories",
    "ecr:DescribeImages",
    "ecr:BatchGetImage",
    "ecr:PutImage",
    "ecr:BatchDeleteImage",
    "ecr:PutLifecyclePolicy",
    "ecr:GetLifecyclePolicy"
  ],
  "Resource": "*"
},
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": [
        "arn:aws:s3:::haoxdong-collective-sessions/dev-slots/DEV_SLOT_HARNESS",
        "arn:aws:s3:::haoxdong-collective-sessions/dev-slots/DEV_SLOT_ORIGIN",
        "arn:aws:s3:::haoxdong-collective-sessions/dev-slots/DEV_SLOT_WEB"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::haoxdong-collective-sessions"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::haoxdong-collective-sessions/deploy-leases/harness",
        "arn:aws:s3:::haoxdong-collective-sessions/deploy-leases/origin",
        "arn:aws:s3:::haoxdong-collective-sessions/deploy-leases/web"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::$AWS_ACCOUNT_ID:role/cdk-hnb659fds-*-role-$AWS_ACCOUNT_ID-$AWS_REGION"
    },
    {
      "Effect": "Allow",
      "Action": ["ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "cloudformation:UpdateStack",
      "Resource": ["arn:aws:cloudformation:$AWS_REGION:$AWS_ACCOUNT_ID:stack/$EGRESS_STACK/*", "arn:aws:cloudformation:$AWS_REGION:$AWS_ACCOUNT_ID:stack/$ORIGIN_STACK/*", "arn:aws:cloudformation:$AWS_REGION:$AWS_ACCOUNT_ID:stack/$HEALTH_STACK/*"]
    },
    {
      "Effect": "Allow",
      "Action": "ssm:GetParameters",
      "Resource": "arn:aws:ssm:$AWS_REGION:$AWS_ACCOUNT_ID:parameter/cdk-bootstrap/hnb659fds/version"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::$AWS_ACCOUNT_ID:role/cdk-hnb659fds-cfn-exec-role-$AWS_ACCOUNT_ID-$AWS_REGION",
      "Condition": {"StringEquals": {"iam:PassedToService": "cloudformation.amazonaws.com"}}
    },
    {
      "Effect": "Allow",
      "Action": "cloudformation:ListExports",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "cloudformation:GetTemplate",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResource",
        "cloudformation:DescribeStacks",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:ListStackResources"
      ],
      "Resource": ["arn:aws:cloudformation:$AWS_REGION:$AWS_ACCOUNT_ID:stack/$STACK_FAMILY-*/*", "arn:aws:cloudformation:$AWS_REGION:$AWS_ACCOUNT_ID:stack/ChatStorage/*", "arn:aws:cloudformation:$AWS_REGION:$AWS_ACCOUNT_ID:stack/AgentCore-$STACK_FAMILY-*/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["bedrock-agentcore:GetAgentRuntimeEndpoint", "bedrock-agentcore:UpdateAgentRuntime", "bedrock-agentcore:StopRuntimeSession"],
      "Resource": "arn:aws:bedrock-agentcore:$AWS_REGION:$AWS_ACCOUNT_ID:runtime/${STACK_FAMILY}_runtime-*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::$AWS_ACCOUNT_ID:role/$RUNTIME_ROLE",
      "Condition": {"StringEquals": {"iam:PassedToService": "bedrock-agentcore.amazonaws.com"}}
    },
    {
      "Effect": "Allow",
      "Action": "ecs:RunTask",
      "Resource": "arn:aws:ecs:$AWS_REGION:$AWS_ACCOUNT_ID:task-definition/PreviewOriginChatServiceReaperTask*",
      "Condition": {"ArnEquals": {"ecs:cluster": "arn:aws:ecs:$AWS_REGION:$AWS_ACCOUNT_ID:cluster/$CLUSTER"}}
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::$AWS_ACCOUNT_ID:role/$STACK_FAMILY-preview-origin-ChatServiceReaperTask*",
      "Condition": {"StringEquals": {"iam:PassedToService": "ecs-tasks.amazonaws.com"}}
    },
    {
      "Effect": "Allow",
      "Action": "events:DescribeRule",
      "Resource": "arn:aws:events:$AWS_REGION:$AWS_ACCOUNT_ID:rule/$STACK_FAMILY-preview-origin-*"
    },
    {
      "Effect": "Allow",
      "Action": "ecs:UpdateService",
      "Resource": [
        "arn:aws:ecs:$AWS_REGION:$AWS_ACCOUNT_ID:service/$CLUSTER/chat-service-preview",
        "arn:aws:ecs:$AWS_REGION:$AWS_ACCOUNT_ID:service/$CLUSTER/credential-service"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["cloudwatch:DescribeAlarms", "cloudwatch:GetMetricStatistics"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "route53:GetHealthCheck",
      "Resource": "arn:aws:route53:::healthcheck/*"
    },
    {
      "Effect": "Allow",
      "Action": "sns:ListSubscriptionsByTopic",
      "Resource": "arn:aws:sns:$AWS_REGION:$AWS_ACCOUNT_ID:$ALERTS_TOPIC"
    },
    {
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:$AWS_REGION:$AWS_ACCOUNT_ID:parameter/$STACK_FAMILY/agentcore/runtime-arn"
    },
    {
      "Effect": "Allow",
      "Action": "bedrock-agentcore:ListMemories",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["bedrock-agentcore:GetMemory", "bedrock-agentcore:ListEvents", "bedrock-agentcore:ListSessions"],
      "Resource": "arn:aws:bedrock-agentcore:$AWS_REGION:$AWS_ACCOUNT_ID:memory/$MEMORY_NAME-*"
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:PutParameter"],
      "Resource": "arn:aws:ssm:$AWS_REGION:$AWS_ACCOUNT_ID:parameter$PARK_STATE"
    },
    {
      "Effect": "Allow",
      "Action": "states:ListStateMachines",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "states:ListExecutions",
      "Resource": "arn:aws:states:$AWS_REGION:$AWS_ACCOUNT_ID:stateMachine:$PARKING_FUNCTION-transition"
    },
    {
      "Effect": "Allow",
      "Action": "states:DescribeExecution",
      "Resource": "arn:aws:states:$AWS_REGION:$AWS_ACCOUNT_ID:execution:$PARKING_FUNCTION-transition:*"
    },
    {
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": "arn:aws:lambda:$AWS_REGION:$AWS_ACCOUNT_ID:function:$PARKING_FUNCTION"
    },
    {
      "Effect": "Allow",
      "Action": ["application-autoscaling:DescribeScalableTargets", "application-autoscaling:RegisterScalableTarget"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["lambda:PutProvisionedConcurrencyConfig", "lambda:DeleteProvisionedConcurrencyConfig", "lambda:GetProvisionedConcurrencyConfig", "lambda:ListProvisionedConcurrencyConfigs", "lambda:GetAlias", "lambda:UpdateAlias"],
      "Resource": ["arn:aws:lambda:$AWS_REGION:$AWS_ACCOUNT_ID:function:$SESSION_API", "arn:aws:lambda:$AWS_REGION:$AWS_ACCOUNT_ID:function:$SESSION_API:*"]
    },
    {
      "Effect": "Allow",
      "Action": ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ec2:DescribeRouteTables", "ec2:DescribeNatGateways", "ec2:DescribeNetworkInterfaces", "ec2:DescribeAddresses"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "dynamodb:GetItem",
      "Resource": "arn:aws:dynamodb:$AWS_REGION:$AWS_ACCOUNT_ID:table/chat",
      "Condition": {"ForAllValues:StringLike": {"dynamodb:LeadingKeys": ["ACCOUNT#*"]}}
    },
    {
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:Query", "dynamodb:BatchWriteItem", "dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:$AWS_REGION:$AWS_ACCOUNT_ID:table/chat",
      "Condition": {
        "ForAllValues:StringLike": {"dynamodb:LeadingKeys": ["ACCOUNT#acct_*", "TOKEN#test_*", "SESSIONS#acct_*"]},
        "Null": {"dynamodb:LeadingKeys": "false"}
      }
    },
    {
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:$AWS_REGION:$AWS_ACCOUNT_ID:table/chat",
      "Condition": {
        "ForAllValues:StringLike": {"dynamodb:LeadingKeys": ["PAID_EXECUTION#origin-smoke"]},
        "Null": {"dynamodb:LeadingKeys": "false"}
      }
    },
    {
      "Effect": "Allow",
      "Action": "dynamodb:UpdateItem",
      "Resource": "arn:aws:dynamodb:$AWS_REGION:$AWS_ACCOUNT_ID:table/chat",
      "Condition": {
        "ForAllValues:StringLike": {"dynamodb:LeadingKeys": ["SESSIONS#acct_*"]},
        "Null": {"dynamodb:LeadingKeys": "false"}
      }
    },
    {
      "Effect": "Allow",
      "Action": ["elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:DescribeTargetGroupAttributes", "elasticloadbalancing:DescribeLoadBalancerAttributes"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:DescribeLogStreams",
        "logs:FilterLogEvents"
      ],
      "Resource": "arn:aws:logs:$AWS_REGION:$AWS_ACCOUNT_ID:log-group:/$STACK_FAMILY/*"
    },
    {
      "Effect": "Allow",
      "Action": "logs:FilterLogEvents",
      "Resource": "arn:aws:logs:$AWS_REGION:$AWS_ACCOUNT_ID:log-group:/aws/bedrock-agentcore/runtimes/${STACK_FAMILY}_runtime-*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetObject"],
      "Resource": [
        "arn:aws:s3:::$STACK_FAMILY-preview-origin-connectionlogs*",
        "arn:aws:s3:::$STACK_FAMILY-preview-origin-connectionlogs*/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"],
      "Resource": "arn:aws:secretsmanager:$AWS_REGION:$AWS_ACCOUNT_ID:secret:$ORIGIN_TOKEN_SECRET-*"
    },
    {
      "Effect": "Allow",
      "Action": "secretsmanager:DescribeSecret",
      "Resource": "arn:aws:secretsmanager:$AWS_REGION:$AWS_ACCOUNT_ID:secret:$TURN_IDENTITY_SECRET-*"
    },
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": ["arn:aws:secretsmanager:$AWS_REGION:$AWS_ACCOUNT_ID:secret:$ORIGIN_PULL_SECRET-*", "arn:aws:secretsmanager:$AWS_REGION:$AWS_ACCOUNT_ID:secret:$ORIGIN_TOKEN_SECRET-*"]
    }
  ]
}
EOF

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "file://$TRUST_POLICY"
else
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --description 'GitHub Actions deploy role for the ECS production topology stacks' \
    --assume-role-policy-document "file://$TRUST_POLICY" \
    >/dev/null
fi
aws iam update-role \
  --role-name "$ROLE_NAME" \
  --max-session-duration 7200
node "$SCRIPT_DIR/managed-deploy-policies.mjs" deploy "$ROLE_POLICY"

# Production starts Live. Only park and unpark change the stored state afterwards
# (scripts/production/production-parking.md), so never overwrite it here.
if ! created="$(aws ssm put-parameter --name "$PARK_STATE" --type String --value live 2>&1)"; then
  grep -q ParameterAlreadyExists <<<"$created" || { echo "$created" >&2; exit 1; }
fi
printf 'Park state %s: %s\n' "$PARK_STATE" "$(aws ssm get-parameter --name "$PARK_STATE" --query Parameter.Value --output text)"

printf 'Bootstrapped %s\n' "arn:aws:iam::$AWS_ACCOUNT_ID:role/$ROLE_NAME"
printf 'Set the deployment role ARN in the bot GitHub environment.\n'
