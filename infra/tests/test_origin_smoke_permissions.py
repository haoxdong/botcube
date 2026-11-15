import json
from fnmatch import fnmatchcase
from pathlib import Path
from unittest.mock import Mock

from origin_smoke import OriginSmoke


def test_bootstrap_authorizes_smoke_admission_and_session_binding():
    source = (Path(__file__).resolve().parents[1] / 'ecs/bootstrap-deploy-role.sh').read_text()
    policy = json.loads(source.split('cat > "$ROLE_POLICY" <<EOF\n')[1].split('\nEOF')[0])
    table = Mock()
    with OriginSmoke(table, Mock()) as smoke:
        smoke.bind('acct_owner', 'session')
    for method, _args, kwargs in table.method_calls:
        action = {'put_item': 'dynamodb:PutItem', 'update_item': 'dynamodb:UpdateItem', 'delete_item': 'dynamodb:DeleteItem'}[method]
        key = kwargs.get('Key', kwargs.get('Item'))['pk']
        grants = [statement for statement in policy['Statement']
                  if statement['Effect'] == 'Allow' and action in statement['Action']
                  and statement['Resource'] == 'arn:aws:dynamodb:$AWS_REGION:$AWS_ACCOUNT_ID:table/chat'
                  and statement.get('Condition', {}).get('Null', {}).get('dynamodb:LeadingKeys') == 'false'
                  and any(fnmatchcase(key, pattern) for pattern in statement['Condition'].get(
                      'ForAllValues:StringLike', {}).get('dynamodb:LeadingKeys', []))]
        assert grants, f'{action} is missing for {key}'
    assert any('bedrock-agentcore:StopRuntimeSession' in statement['Action']
               and statement['Resource'] == 'arn:aws:bedrock-agentcore:$AWS_REGION:$AWS_ACCOUNT_ID:runtime/${STACK_FAMILY}_runtime-*'
               for statement in policy['Statement'])
