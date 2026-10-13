#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == '--profile' ]]; then
  test -n "${2:-}"
  export AWS_PROFILE="$2"
  shift 2
fi
if [[ "$#" -ne 0 ]]; then
  echo 'usage: bootstrap-deploy-role.sh [--profile AWS_PROFILE]' >&2
  exit 2
fi

read -r AWS_ACCOUNT_ID AWS_REGION STACK_FAMILY CLUSTER ROLE_NAME ORIGIN_PULL_SECRET ORIGIN_TOKEN_SECRET ALERTS_TOPIC MEMORY_NAME PARK_STATE OIDC_SUBJECT POLICY_NAME < <(node -e '
  const identity = require(process.argv[1]);
  process.stdout.write([
    identity.aws.account,
    identity.aws.region,
    identity.aws.cloudFormation.stackFamily,
    identity.aws.ecs.cluster,
    identity.aws.ecs.deployRoleName,
    identity.aws.ecs.originPullClientSecretName,
    identity.aws.ecs.originTokenSecretName,
    identity.aws.ecs.alertsTopicName,
    identity.aws.agentCore.memory,
    identity.ssm.parkState,
    identity.github.oidcSubject,
    identity.aws.ecs.deployPolicyName,
  ].join(" ") + "\n");
' "${CARTRIDGE_DEPLOY_ROOT:?}/identity.json")

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
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::$AWS_ACCOUNT_ID:role/cdk-hnb659fds-*-role-$AWS_ACCOUNT_ID-$AWS_REGION"
    },
    {
      "Effect": "Allow",
      "Action": [
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
      "Action": ["bedrock-agentcore:GetAgentRuntime", "bedrock-agentcore:GetAgentRuntimeEndpoint"],
      "Resource": "arn:aws:bedrock-agentcore:$AWS_REGION:$AWS_ACCOUNT_ID:runtime/${STACK_FAMILY}_runtime-*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeServices",
        "ecs:DescribeTasks"
      ],
      "Resource": [
        "arn:aws:ecs:$AWS_REGION:$AWS_ACCOUNT_ID:service/$CLUSTER/*",
        "arn:aws:ecs:$AWS_REGION:$AWS_ACCOUNT_ID:task/$CLUSTER/*"
      ]
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
      "Resource": "arn:aws:ecs:$AWS_REGION:$AWS_ACCOUNT_ID:service/$CLUSTER/chat-service-preview"
    },
    {
      "Effect": "Allow",
      "Action": "ecs:ListTasks",
      "Resource": "*",
      "Condition": {
        "ArnEquals": {
          "ecs:cluster": "arn:aws:ecs:$AWS_REGION:$AWS_ACCOUNT_ID:cluster/$CLUSTER"
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:DescribeClusters"],
      "Resource": "arn:aws:ecs:$AWS_REGION:$AWS_ACCOUNT_ID:cluster/$CLUSTER"
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
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:$AWS_REGION:$AWS_ACCOUNT_ID:secret:$ORIGIN_PULL_SECRET-*"
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
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "file://$ROLE_POLICY"

# Production starts Live. Only park and unpark change the stored state afterwards
# (docs/runbooks/production-parking.md), so never overwrite it here.
if ! created="$(aws ssm put-parameter --name "$PARK_STATE" --type String --value live 2>&1)"; then
  grep -q ParameterAlreadyExists <<<"$created" || { echo "$created" >&2; exit 1; }
fi
printf 'Park state %s: %s\n' "$PARK_STATE" "$(aws ssm get-parameter --name "$PARK_STATE" --query Parameter.Value --output text)"

printf 'Bootstrapped %s\n' "arn:aws:iam::$AWS_ACCOUNT_ID:role/$ROLE_NAME"
printf 'Set the deployment role ARN in the Cartridge GitHub environment.\n'
