from __future__ import annotations

import argparse
import os
from pathlib import Path

import boto3
import session_reid as reid
from botocore.exceptions import ClientError


def main() -> None:
    parser = argparse.ArgumentParser(description='One Session ID per chat: plan the three collision-only empty-Session re-IDs')
    parser.add_argument('operation', choices=('plan', 'backup', 'apply', 'rollback'))
    parser.add_argument('--region', default=os.getenv('AWS_REGION', 'us-east-1'))
    parser.add_argument('--profile')
    parser.add_argument('--table', default='chat')
    parser.add_argument('--memory', required=True)
    parser.add_argument('--decision-repository', required=True)
    parser.add_argument('--decision-item', required=True, type=int)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--backup', type=Path)
    parser.add_argument('--approval', type=Path)
    args = parser.parse_args()
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    table = session.resource('dynamodb').Table(args.table)
    memory = session.client('bedrock-agentcore')
    if args.operation == 'plan':
        manifest = reid.plan(reid.scan(table), memory, table=args.table, memory=args.memory, region=args.region,
                             decision_repository=args.decision_repository, decision_item=args.decision_item)
        reid.save_private(args.manifest, manifest)
        print(f"Manifest SHA256 {reid.digest(manifest)}; re-IDs {len(manifest['reids'])}; blockers {len(manifest['blockers'])}")
        if manifest['blockers']:
            raise SystemExit(1)
        return
    manifest = reid.read_json(args.manifest)
    if (manifest['table'], manifest['memory'], manifest['region'], manifest['decision_repository'], manifest.get('decision_item')) != (
            args.table, args.memory, args.region, args.decision_repository, args.decision_item):
        parser.error('Manifest names a different table, Memory, region or decision')
    if args.backup is None:
        parser.error('--backup is required')
    if args.operation == 'backup':
        saved = reid.backup(manifest, table, memory)
        reid.save_private(args.backup, saved)
        print(f'Backup SHA256 {reid.digest(saved)}; no stored data changed')
        return
    if args.approval is None:
        parser.error('--approval is required; code preparation does not authorize execution')
    reid.execute(manifest, reid.read_json(args.backup), reid.read_json(args.approval), table, memory,
                 rollback=args.operation == 'rollback')
    print(f'{args.operation} verified; admission must remain closed for cutover acceptance')


if __name__ == '__main__':
    try:
        main()
    except ClientError as error:
        code = error.response.get('Error', {}).get('Code', 'unclassified error')
        raise SystemExit(f'AWS {error.operation_name} failed with {code}; private identities omitted') from None
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
