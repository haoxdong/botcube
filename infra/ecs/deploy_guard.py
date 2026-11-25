"""The parking transition's first-state check: a park refuses while a production deploy holds it off.

A deploy takes deploy-leases/<slot> before it checks for a running transition; a transition execution is the park's
claim, and this check runs inside it. So whichever side checks second sees the other and refuses."""
import re
from datetime import UTC, datetime

from botocore.exceptions import ClientError
from deploy_identity import load_deployment
from transition import SETTLED

RESOLVED = load_deployment()
NAMES = RESOLVED['physicalNames']
IDENTITY = RESOLVED['config']
# What a production deploy changes: the harness, the origin and the web stacks.
DEPLOYED_STACKS = (f"AgentCore-{IDENTITY['name']}-default",
                   NAMES['previewOriginStackName'], NAMES['webLatencyStackName'])
DEPLOY_LEASES = 'deploy-leases/'
LEASE_STALE_SECONDS = 7200


class DeployInFlight(RuntimeError):
    """A park refused before any effect: a deploy holds a lease or left a stack unsettled."""


def require_no_deploy(cloudformation, leases, now, refusal: type[Exception] = DeployInFlight):
    """Refuse while a lease under 2 h old exists, or a deployed stack is not settled; a missing stack passes."""
    bucket = IDENTITY['existing']['buckets']['slots']['bucketName']
    for item in leases.list_objects_v2(Bucket=bucket, Prefix=DEPLOY_LEASES).get('Contents', []):
        holder = leases.get_object(Bucket=bucket, Key=item['Key'])['Body'].read().decode().strip()
        # An unreadable time counts as fresh: the COO reads the holder in the refusal and deletes the lease by hand.
        at = re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', holder.rpartition(' ')[2])
        age = now - datetime.strptime(at[0], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=UTC).timestamp() if at else 0
        if age < LEASE_STALE_SECONDS:
            raise refusal(f"Park refused: the {item['Key'].removeprefix(DEPLOY_LEASES)} slot's deploy lease "
                                 f"s3://{bucket}/{item['Key']} is {int(age // 60)} min old, held by {holder}; nothing changed")
    for name in DEPLOYED_STACKS:
        try:
            status = cloudformation.describe_stacks(StackName=name)['Stacks'][0]['StackStatus']
        except ClientError as error:
            if 'does not exist' in error.response['Error'].get('Message', ''):
                continue
            raise
        if status not in SETTLED:
            raise refusal(f'Park refused: {name} is {status}, not a settled *_COMPLETE state; nothing changed')
