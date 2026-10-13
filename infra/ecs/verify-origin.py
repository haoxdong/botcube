"""Real origin access proof. Optional AOP interruption requires coordination."""
from __future__ import annotations

import argparse
import gzip
import importlib
import json
import os
import shlex
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

import boto3

IDENTITY = json.loads((Path(os.environ['CARTRIDGE_DEPLOY_ROOT']) / 'identity.json').read_text())
os.environ.update({
    'ORIGIN_OWNERSHIP': IDENTITY['aws']['ecs']['originOwnership'],
    'PARKED_WORKER_NAME': IDENTITY['aws']['ecs']['parkedWorkerName'],
    'ORIGIN_ZONE': IDENTITY['aws']['ecs']['originZone'],
})
sys.path.insert(0, str(Path(__file__).parent / 'origin-provider'))
handler = importlib.import_module('handler')
OWNER = handler.OWNER
if TYPE_CHECKING:
    from handler import Cloudflare
    from types_boto3_s3 import S3Client
else:
    Cloudflare = handler.Cloudflare


def hostname(url: str) -> str:
    host = urllib.parse.urlparse(url).hostname
    if host is None:
        raise RuntimeError('Identity domain has no hostname: ' + url)
    return host


HOST = hostname(IDENTITY['domains']['chatServicePreview'])
PRODUCTION_HOST = hostname(IDENTITY['domains']['chatService'])


def now():
    return datetime.now(UTC)


def request_status(host: str = HOST, timeout: float = 40):
    request = urllib.request.Request('https://' + host + '/health?origin-proof=' + str(time.time_ns()), headers={'User-Agent': IDENTITY['verification']['originUserAgent'], 'Cache-Control': 'no-cache', 'Connection': 'close'})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def expect_ready(host: str = HOST):
    # Cloudflare's active control-plane association can precede the certificate
    # actually presented to the ALB. Await the data-plane condition explicitly.
    deadline = time.monotonic() + 300
    for _ in range(30):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        status, body = request_status(host, timeout=min(40, remaining))
        if status == 200 and json.loads(body) == {'status': 'ok'}:
            print('Authenticated request reached Chat Service readiness', flush=True)
            return
        if status not in (520, 525):
            raise RuntimeError('Expected Chat Service readiness; received HTTP ' + str(status))
        print('Awaiting trusted origin response after AOP update: HTTP ' + str(status), flush=True)
        time.sleep(min(10, max(0, deadline - time.monotonic())))
    raise RuntimeError('Trusted origin response did not converge within five minutes')


def set_aop(cf: Cloudflare, base: str, cert_id: str, enabled: bool):
    cf.call(base, 'PUT', {'config': [{'hostname': HOST, 'cert_id': cert_id, 'enabled': enabled}]})
    for _ in range(30):
        state = cf.call(base + '/' + HOST)
        if state.get('enabled') is enabled and state.get('cert_id') == cert_id and state.get('status') == 'active':
            return
        time.sleep(10)
    raise RuntimeError('Preview AOP association did not converge')


def active_certificate(cf: Cloudflare, base: str, cert_id: str):
    for _ in range(30):
        state = cf.call(base + '/certificates/' + cert_id)
        if state['status'] == 'active':
            return
        if state['status'] not in ('initializing', 'pending_deployment'):
            raise RuntimeError('Probe client certificate deployment failed')
        time.sleep(10)
    raise RuntimeError('Probe certificate activation timed out')


def tls_failure_phase(cf: Cloudflare, base: str, cert_id: str, enabled: bool):
    set_aop(cf, base, cert_id, enabled)
    # The stack caps ALB connection lifetime at 60s. Let old authenticated
    # connections expire before generating the isolated negative handshake.
    time.sleep(70)
    start = now()
    status, _ = request_status()
    if status not in (520, 525):
        raise RuntimeError('Expected Cloudflare origin failure (520/525), received ' + str(status))
    end = now()
    print('Preview negative probe returned ' + str(status) + '; ALB TLS evidence still required', flush=True)
    return start, end, status


# ALB and probe hosts have independent clocks (observed 28-30 ms skew).
# Keep correlation bounded and retain the exact diagnostic serial check.
CLOCK_MARGIN = timedelta(seconds=1)


def connection_log_lines(s3: S3Client, bucket: str, first: datetime) -> Iterator[str]:
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix='origin/AWSLogs/'):
        for item in page.get('Contents', []):
            if 'Key' not in item or 'LastModified' not in item:
                raise RuntimeError('S3 listing entry lacks Key or LastModified')
            if item['LastModified'] < first or not item['Key'].endswith('.log.gz'):
                continue
            body = s3.get_object(Bucket=bucket, Key=item['Key'])['Body'].read()
            yield from gzip.decompress(body).decode().splitlines()


def is_phase_failure(phase: str, fields: list[str], serial: str):
    if phase == 'missing':
        return fields[7] == '-' and fields[9] == '-' and fields[10].startswith('Failed:')
    return phase == 'untrusted' and fields[9].lstrip('0').upper() == serial.lstrip('0').upper() and fields[10] == 'Failed:ClientCertUntrusted'


def record_phase_evidence(evidence: dict[str, str], line: str, phases: Mapping[str, tuple[datetime, datetime, int]], serial: str):
    fields = shlex.split(line)
    timestamp = datetime.fromisoformat(fields[0].replace('Z', '+00:00'))
    for phase, (start, end, _) in phases.items():
        in_phase = start - CLOCK_MARGIN <= timestamp <= end + CLOCK_MARGIN and fields[3] == '443'
        if in_phase and is_phase_failure(phase, fields, serial):
            evidence[phase] = line


def connection_evidence(bucket: str, phases: Mapping[str, tuple[datetime, datetime, int]], serial: str):
    s3 = boto3.client('s3')
    evidence: dict[str, str] = {}
    first = min(phase[0] for phase in phases.values()) - CLOCK_MARGIN
    for _ in range(50):
        for line in connection_log_lines(s3, bucket, first):
            record_phase_evidence(evidence, line, phases, serial)
        if len(evidence) == 2:
            return evidence
        time.sleep(15)
    raise RuntimeError('ALB TLS log evidence missing for: ' + ', '.join(set(phases) - set(evidence)))


def verify(cf: Cloudflare, zone: str, outputs: Mapping[str, str], *, probe_aop: bool = False):
    addresses = {str(item[4][0]) for item in socket.getaddrinfo(outputs['OriginDnsName'], 443, socket.AF_INET)}
    for address in addresses:
        try:
            with socket.create_connection((address, 443), timeout=5):
                raise RuntimeError('Public origin unexpectedly accepts non-Cloudflare TCP traffic')
        except TimeoutError:
            print('Non-Cloudflare TCP timeout: ' + address, flush=True)
    expect_ready()
    base = zone + '/origin_tls_client_auth/hostnames'
    trusted_id = outputs['ClientCertificateId']
    original = cf.call(base + '/' + HOST)
    if original.get('cert_id') != trusted_id or original.get('enabled') is not True:
        raise RuntimeError('Preview association differs from the deployed stack')
    if not probe_aop:
        result = {'network_rejection_addresses': sorted(addresses), 'trusted_aop': True,
                  'readiness': True, 'interruption_probes': 'not requested',
                  'revision': os.environ.get('GITHUB_SHA'), 'verified_at': now().isoformat()}
        Path(os.environ['RUNNER_TEMP'], 'origin-access-evidence.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result), flush=True)
        return
    with tempfile.TemporaryDirectory(prefix='origin-negative-') as directory:
        certificate, key = Path(directory) / 'client.crt', Path(directory) / 'client.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=preview-untrusted-probe', '-addext', 'basicConstraints=critical,CA:FALSE',
                        '-addext', 'extendedKeyUsage=clientAuth', '-keyout', str(key), '-out', str(certificate)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        serial = subprocess.check_output(['openssl', 'x509', '-in', str(certificate), '-noout', '-serial'], text=True).strip().split('=')[1]
        untrusted_id = cf.call(base + '/certificates', 'POST', {'certificate': certificate.read_text(), 'private_key': key.read_text()})['id']
        phases: dict[str, tuple[datetime, datetime, int]] = {}
        try:
            active_certificate(cf, base, untrusted_id)
            phases['missing'] = tls_failure_phase(cf, base, trusted_id, False)
            phases['untrusted'] = tls_failure_phase(cf, base, untrusted_id, True)
        finally:
            set_aop(cf, base, trusted_id, True)
            try:
                time.sleep(70)
                expect_ready()
            finally:
                cf.call(base + '/certificates/' + untrusted_id, 'DELETE')
            print('Trusted AOP restored and diagnostic certificate removed', flush=True)
        evidence = connection_evidence(outputs['ConnectionLogsBucket'], phases, serial)
        result = {'network_rejection_addresses': sorted(addresses), 'tls_connection_logs': evidence,
                  'edge_statuses': {name: phase[2] for name, phase in phases.items()},
                  'revision': os.environ.get('GITHUB_SHA'), 'verified_at': now().isoformat()}
        Path(os.environ.get('RUNNER_TEMP', directory), 'origin-access-evidence.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result), flush=True)


def verify_production(cf: Cloudflare, zone: str, outputs: Mapping[str, str]):
    records = cf.records(zone, PRODUCTION_HOST)
    if (len(records) != 1 or records[0].get('comment') != OWNER or records[0].get('type') != 'CNAME' or records[0].get('proxied') is not True
            or records[0].get('content', '').lower() != outputs['OriginDnsName'].rstrip('.').lower()):
        raise RuntimeError('Production DNS does not point at the ECS origin')
    association = cf.call(zone + '/origin_tls_client_auth/hostnames/' + PRODUCTION_HOST)
    if association.get('cert_id') != outputs['ProductionClientCertificateId'] or association.get('enabled') is not True:
        raise RuntimeError('Production AOP association differs from the deployed stack')
    expect_ready(PRODUCTION_HOST)
    print(json.dumps({'production_dns': 'ecs-origin', 'trusted_aop': True, 'readiness': True}), flush=True)


def parse_args(argv: list[str]):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    verify_command = commands.add_parser('verify')
    verify_command.add_argument('outputs')
    verify_command.add_argument('--probe-aop', action='store_true', help='Interrupt preview AOP only after coordination')
    commands.add_parser('production').add_argument('outputs')
    return parser.parse_args(argv)


if __name__ == '__main__':
    args = parse_args(sys.argv[1:])
    cf = Cloudflare(os.environ['CLOUDFLARE_ORIGIN_API_TOKEN'])
    zone = cf.zone()
    outputs = json.loads(Path(args.outputs).read_text())[IDENTITY['aws']['ecs']['previewOriginStackName']]
    if args.action == 'production':
        verify_production(cf, zone, outputs)
    else:
        verify(cf, zone, outputs, probe_aop=args.probe_aop)
