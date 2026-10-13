#!/usr/bin/env bash
# Add only rollback exercise privileges; preserve concurrent preview deploy policy updates.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == '--profile' ]]; then
  export AWS_PROFILE="${2:?profile required}"
  shift 2
fi
test "$#" -eq 0
read -r ACCOUNT REGION CLUSTER ROLE TASK_FAMILY POLICY_NAME < <(node -e '
const x = require(process.argv[1]).aws;
console.log(x.account, x.region, x.ecs.cluster, x.ecs.deployRoleName, x.ecs.rollbackTaskFamilyPrefix, x.ecs.rollbackPolicyName);
' "${CARTRIDGE_DEPLOY_ROOT:?}/identity.json")
REVISION="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services chat-service-preview --query 'services[0].taskDefinition' --output text)"
read -r TASK_ROLE EXECUTION_ROLE IMAGE < <(aws ecs describe-task-definition --region "$REGION" --task-definition "$REVISION" --query 'taskDefinition.[taskRoleArn,executionRoleArn,containerDefinitions[0].image]' --output text)
test -n "$TASK_ROLE"
test -n "$EXECUTION_ROLE"
REPOSITORY="${IMAGE#*/}"
REPOSITORY="${REPOSITORY%%[:@]*}"
POLICY="$(mktemp)"
trap 'rm -f "$POLICY"' EXIT
cat > "$POLICY" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ecr:BatchGetImage",
      "Resource": "arn:aws:ecr:$REGION:$ACCOUNT:repository/$REPOSITORY"
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:ListServiceDeployments", "ecs:DescribeServiceDeployments", "ecs:DescribeServiceRevisions"],
      "Resource": [
        "arn:aws:ecs:$REGION:$ACCOUNT:service/$CLUSTER/chat-service-preview",
        "arn:aws:ecs:$REGION:$ACCOUNT:service-deployment/$CLUSTER/chat-service-preview/*",
        "arn:aws:ecs:$REGION:$ACCOUNT:service-revision/$CLUSTER/chat-service-preview/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:ListTaskDefinitions", "ecs:DescribeTaskDefinition"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "ecs:RegisterTaskDefinition",
      "Resource": "*",
      "Condition": {
        "StringLike": {"aws:RequestTag/preview-rollback-owner": "?*"},
        "ForAllValues:StringEquals": {"aws:TagKeys": ["preview-rollback-owner"]}
      }
    },
    {
      "Effect": "Allow",
      "Action": "ecs:TagResource",
      "Resource": "arn:aws:ecs:$REGION:$ACCOUNT:task-definition/${TASK_FAMILY}*:*",
      "Condition": {"StringEquals": {"ecs:CreateAction": "RegisterTaskDefinition"}}
    },
    {
      "Effect": "Allow",
      "Action": "ecs:ListTagsForResource",
      "Resource": "arn:aws:ecs:$REGION:$ACCOUNT:task-definition/${TASK_FAMILY}*:*"
    },
    {
      "Effect": "Allow",
      "Action": "ecs:DeregisterTaskDefinition",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": ["$TASK_ROLE", "$EXECUTION_ROLE"],
      "Condition": {"StringEquals": {"iam:PassedToService": "ecs-tasks.amazonaws.com"}}
    }
  ]
}
EOF
aws iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" --policy-document "file://$POLICY"
printf 'Added scoped rollback exercise policy to %s\n' "$ROLE"
