"""One-off: delete the former Journal's items from the `chat` table (ADR 0067, #2189).

The Journal, the Chat Service's retired replay log, kept an owner index under
``pk = OWNER#<owner>`` (``sk = THREAD#<id>`` and ``JOURNAL#DELETED``) and each
thread under ``pk = THREAD#<hex>`` (``META``, ``DATA#...``, ``RUN#...``,
``EVENT#...``). Nothing else in the table uses those partition prefixes.

A dry run (the default) prints how many items each prefix holds; ``--delete``
deletes them. Idempotent: a rerun finds none. Only counts are printed, since
the keys hold account IDs, which are bearer secrets.
"""

from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Iterator, Sequence
from typing import TYPE_CHECKING

import boto3
from boto3.dynamodb.conditions import Attr

if TYPE_CHECKING:
    from types_boto3_dynamodb.service_resource import Table

PREFIXES = ('OWNER#', 'THREAD#')


def journal_keys(table: Table) -> Iterator[tuple[str, str]]:
    condition = Attr('pk').begins_with(PREFIXES[0]) | Attr('pk').begins_with(PREFIXES[1])
    kwargs = {'FilterExpression': condition, 'ProjectionExpression': 'pk, sk'}
    while True:
        page = table.scan(**kwargs)
        for item in page['Items']:
            pk, sk = item['pk'], item['sk']
            if not isinstance(pk, str) or not isinstance(sk, str):
                raise RuntimeError('Chat table item key is not a string pk and sk')
            yield pk, sk
        if 'LastEvaluatedKey' not in page:
            return
        kwargs['ExclusiveStartKey'] = page['LastEvaluatedKey']


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=str(__doc__).splitlines()[0])
    parser.add_argument('--table', default='chat')
    parser.add_argument('--profile')
    parser.add_argument('--region')
    parser.add_argument('--delete', action='store_true', help='delete the items; without it, a dry run')
    args = parser.parse_args(argv)
    table = boto3.Session(profile_name=args.profile, region_name=args.region).resource('dynamodb').Table(args.table)

    keys = list(journal_keys(table))
    counts = Counter(prefix for pk, _ in keys for prefix in PREFIXES if pk.startswith(prefix))
    for prefix in PREFIXES:
        print(f'{prefix}: {counts[prefix]}')
    if not args.delete:
        print(f'dry run: {len(keys)} Journal items would be deleted; rerun with --delete.')
        return
    with table.batch_writer() as batch:
        for pk, sk in keys:
            batch.delete_item(Key={'pk': pk, 'sk': sk})
    print(f'Deleted {len(keys)} Journal items.')


if __name__ == '__main__':
    main()
