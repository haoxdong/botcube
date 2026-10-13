"""CloudFormation ownership of the preview's Cloudflare records and ACM validation.

Secrets are fetched at runtime; neither request/response bodies nor key material
are logged or returned to CloudFormation.
"""
from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

import boto3

if TYPE_CHECKING:
    from types_boto3_acm.type_defs import (
        CertificateDetailTypeDef,
        ResourceRecordTypeDef,
    )

OWNER = os.environ['ORIGIN_OWNERSHIP']
PARKED_SCRIPT = os.environ['PARKED_WORKER_NAME']
PARKED_WORKER = Path(__file__).with_name('parked-worker.mjs')


class ProviderError(RuntimeError):
    def __init__(self, message: str, codes: Iterable[object] = ()):
        super().__init__(message)
        self.codes = tuple(codes)


class Cloudflare:
    def __init__(self, token: str | None = None):
        secrets = boto3.client('secretsmanager')
        self.token = token if token is not None else secrets.get_secret_value(SecretId=os.environ['TOKEN_SECRET'])['SecretString']
        self.secrets = secrets

    def call(self, path: str, method: str = 'GET', body: object = None):
        return self.send(path, method, json.dumps(body).encode() if body is not None else None, 'application/json')

    def send(self, path: str, method: str, data: bytes | None, content_type: str):
        request = urllib.request.Request(
            'https://api.cloudflare.com/client/v4/' + path,
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': content_type},
            method=method, data=data,
        )
        try:
            try:
                with urllib.request.urlopen(request, timeout=25) as response:
                    status, result = response.status, json.load(response)
            except urllib.error.HTTPError as error:
                status, result = error.code, json.load(error)
        except (OSError, ValueError) as error:
            raise ProviderError('Cloudflare transport/response failure') from error
        if not result.get('success'):
            codes = [entry.get('code') for entry in result.get('errors', [])]
            raise ProviderError(f'Cloudflare {method} {path.split("?")[0]} HTTP {status} error codes: ' + json.dumps(codes), codes)
        return result['result']

    def zone_record(self):
        zones = self.call('zones?name=' + urllib.parse.quote(os.environ['ORIGIN_ZONE']))
        if len(zones) != 1:
            raise ProviderError('Expected exactly one Cloudflare zone')
        return zones[0]

    def zone(self):
        return 'zones/' + self.zone_record()['id']

    def account(self):
        return 'accounts/' + self.zone_record()['account']['id']

    def records(self, zone: str, name: str):
        return self.call(zone + '/dns_records?name=' + urllib.parse.quote(name.rstrip('.')))

    def put_record(self, zone: str, name: str, content: str, proxied: bool, record_id: str | None = None):
        records = self.records(zone, name)
        if len(records) > 1:
            raise ProviderError('Ambiguous preview DNS ownership')
        if records:
            record = records[0]
            owned = record.get('comment') == OWNER and (not record_id or record['id'] == record_id)
            if not owned:
                raise ProviderError('Refusing to overwrite an unowned DNS record')
            record_id = record['id']
        payload = {'type': 'CNAME', 'name': name.rstrip('.'), 'content': content.rstrip('.'),
                   'proxied': proxied, 'ttl': 1, 'comment': OWNER}
        path = zone + '/dns_records' + ('/' + record_id if record_id else '')
        return self.call(path, 'PUT' if record_id else 'POST', payload)['id']

    def remove_record(self, zone: str, name: str, record_id: str | None = None):
        records = self.records(zone, name)
        if not records:
            return
        if len(records) != 1 or records[0].get('comment') != OWNER or (record_id and records[0]['id'] != record_id):
            raise ProviderError('Refusing to delete an unowned DNS record')
        self.call(zone + '/dns_records/' + records[0]['id'], 'DELETE')

    def owned_route(self, zone: str, hostname: str):
        routes = [route for route in self.call(zone + '/workers/routes') if route['pattern'] == hostname + '/*']
        if any(route.get('script') != PARKED_SCRIPT for route in routes):
            raise ProviderError('Refusing to touch an unowned Worker route')
        return routes[0] if routes else None

    def upload_parked_worker(self, account: str, origins: list[str]):
        boundary = uuid.uuid4().hex
        metadata = {'main_module': PARKED_WORKER.name, 'compatibility_date': '2026-09-01',
                    'bindings': [{'type': 'plain_text', 'name': 'ALLOWED_ORIGINS', 'text': json.dumps(origins)}]}
        parts = [('metadata', '', 'application/json', json.dumps(metadata)),
                 (PARKED_WORKER.name, f'; filename="{PARKED_WORKER.name}"', 'application/javascript+module', PARKED_WORKER.read_text())]
        body = ''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"{filename}\r\nContent-Type: {kind}\r\n\r\n{content}\r\n'
                       for name, filename, kind, content in parts) + f'--{boundary}--\r\n'
        self.send(account + '/workers/scripts/' + PARKED_SCRIPT, 'PUT', body.encode(), 'multipart/form-data; boundary=' + boundary)


def config(event: Mapping[str, Any]):
    props = event['ResourceProperties']
    if any(hostname not in os.environ['HOSTNAMES'].split(',') for hostname in props.get('Hostnames') or [props['Hostname']]):
        raise ProviderError('Only the identity Chat Service hostnames are permitted')
    old = event.get('OldResourceProperties', {})
    if event['RequestType'] == 'Update' and (props.get('Hostname'), props.get('Hostnames')) != (old.get('Hostname'), old.get('Hostnames')):
        raise ProviderError('Hostname replacement is not supported')
    return props


def certificate_event(cf: Cloudflare, zone: str, event: Mapping[str, Any], props: Mapping[str, Any]):
    acm = boto3.client('acm')
    request, physical = event['RequestType'], event.get('PhysicalResourceId')
    if request == 'Create':
        return acm.request_certificate(
            DomainName=props['Hostname'], ValidationMethod='DNS',
            IdempotencyToken=hashlib.sha256(event['RequestId'].encode()).hexdigest()[:32],
            Tags=[{'Key': 'Owner', 'Value': OWNER}],
        )['CertificateArn']
    if request == 'Delete':
        certificate = acm.describe_certificate(CertificateArn=event['PhysicalResourceId'])['Certificate']
        for record in validation_records(certificate):
            cf.remove_record(zone, record['Name'])
        acm.delete_certificate(CertificateArn=event['PhysicalResourceId'])
    return physical


def dns_event(cf: Cloudflare, zone: str, event: Mapping[str, Any], props: Mapping[str, Any]):
    physical = event.get('PhysicalResourceId')
    if event['RequestType'] == 'Delete':
        cf.remove_record(zone, props['Hostname'], physical)
        return physical
    return cf.put_record(zone, props['Hostname'], props['Target'], True, physical)


def aop_event(cf: Cloudflare, zone: str, event: Mapping[str, Any], props: Mapping[str, Any]):
    request = event['RequestType']
    if 'CertId' in props and request != 'Delete':
        return props['CertId']  # Associates an already-uploaded client certificate.
    if request == 'Create' or (request == 'Update' and props['ClientVersion'] != event['OldResourceProperties']['ClientVersion']):
        secret = json.loads(cf.secrets.get_secret_value(SecretId=os.environ['CLIENT_SECRET'])['SecretString'])
        certificate = cf.call(zone + '/origin_tls_client_auth/hostnames/certificates', 'POST',
                              {'certificate': secret['certificate'], 'private_key': secret['privateKey']})
        return certificate['id']
    # Association and removal wait for Cloudflare's asynchronous deployment.
    return event.get('PhysicalResourceId')


def delete_parked_worker(cf: Cloudflare, zone: str, account: str, hostnames: list[str]):
    for hostname in hostnames:
        route = cf.owned_route(zone, hostname)
        if route:
            cf.call(zone + '/workers/routes/' + route['id'], 'DELETE')
    try:
        cf.call(account + '/workers/scripts/' + PARKED_SCRIPT, 'DELETE')
    except ProviderError as error:
        if error.codes != (10007,):  # An explicit script-not-found is an already-deleted Worker.
            raise


def deploy_parked_worker(cf: Cloudflare, zone: str, account: str, props: Mapping[str, Any]):
    cf.upload_parked_worker(account, props['Origins'])
    for hostname in props['Hostnames']:
        if not cf.owned_route(zone, hostname):
            cf.call(zone + '/workers/routes', 'POST', {'pattern': hostname + '/*', 'script': PARKED_SCRIPT})


def parked_worker_event(cf: Cloudflare, zone: str, event: Mapping[str, Any], props: Mapping[str, Any]):
    account = cf.account()
    if event['RequestType'] == 'Delete':
        delete_parked_worker(cf, zone, account, props['Hostnames'])
    else:
        deploy_parked_worker(cf, zone, account, props)
    return PARKED_SCRIPT


EVENT_HANDLERS = {'Certificate': certificate_event, 'Dns': dns_event, 'Aop': aop_event,
                  'ParkedWorker': parked_worker_event}


def on_event(event: Mapping[str, Any], _context: object) -> dict[str, object]:
    props = config(event)
    kind = props['Kind']
    cf = Cloudflare()
    zone = cf.zone()
    if kind not in EVENT_HANDLERS:
        raise ProviderError('Unknown resource kind')
    physical = EVENT_HANDLERS[kind](cf, zone, event, props)
    return {'PhysicalResourceId': physical, 'Data': {'Arn': physical} if kind == 'Certificate' else {}}


def certificate_issued(cf: Cloudflare, zone: str, physical: str):
    cert = boto3.client('acm').describe_certificate(CertificateArn=physical)['Certificate']
    status = cert.get('Status')
    if status == 'ISSUED':
        return True
    if status != 'PENDING_VALIDATION':
        raise ProviderError(f'ACM certificate status: {status}')
    for record in validation_records(cert):
        cf.put_record(zone, record['Name'], record['Value'], False)
    return False


def validation_records(certificate: CertificateDetailTypeDef) -> list[ResourceRecordTypeDef]:
    if 'DomainValidationOptions' not in certificate:
        raise ProviderError('ACM certificate has no domain validation options')
    return [option['ResourceRecord'] for option in certificate['DomainValidationOptions'] if 'ResourceRecord' in option]


def aop_removed(cf: Cloudflare, base: str, props: Mapping[str, Any], physical: str):
    certificates = cf.call(base + '/certificates')
    if not any(cert['id'] == physical for cert in certificates):
        return True
    hostname = hostname_state(cf, base, props['Hostname'])
    if hostname.get('cert_id') == physical and hostname.get('enabled') is True:
        cf.call(base, 'PUT', {'config': [{'hostname': props['Hostname'], 'cert_id': physical, 'enabled': None}]})
    if 'CertId' in props:
        return True  # The owning resource deletes the shared certificate.
    try:
        cf.call(base + '/certificates/' + physical, 'DELETE')
    except ProviderError as error:
        if error.codes == (1434,):
            return False
        raise
    return True


def aop_associated(cf: Cloudflare, base: str, name: str, physical: str) -> bool:
    certificate = cf.call(base + '/certificates/' + physical)
    if certificate['status'] in ('initializing', 'pending_deployment'):
        return False
    if certificate['status'] != 'active':
        raise ProviderError('Cloudflare client certificate is not active')
    hostname = hostname_state(cf, base, name)
    if hostname.get('enabled') is not True or hostname.get('cert_id') != physical:
        cf.call(base, 'PUT', {'config': [{'hostname': name, 'cert_id': physical, 'enabled': True}]})
        return False
    return hostname.get('enabled') is True and hostname.get('cert_id') == physical and hostname.get('status') == 'active'


def is_complete(event: Mapping[str, Any], _context: object) -> dict[str, bool]:
    props = config(event)
    kind, request = props['Kind'], event['RequestType']
    if kind in ('Dns', 'ParkedWorker') or (kind == 'Certificate' and request == 'Delete'):
        return {'IsComplete': True}
    cf = Cloudflare()
    zone = cf.zone()
    physical = event['PhysicalResourceId']
    if kind == 'Certificate':
        return {'IsComplete': certificate_issued(cf, zone, physical)}
    if kind != 'Aop':
        raise ProviderError('Unknown resource kind')
    base = zone + '/origin_tls_client_auth/hostnames'
    if request == 'Delete':
        return {'IsComplete': aop_removed(cf, base, props, physical)}
    return {'IsComplete': aop_associated(cf, base, props['Hostname'], physical)}


def hostname_state(cf: Cloudflare, base: str, hostname: str) -> dict[str, object]:
    try:
        return cf.call(base + '/' + hostname)
    except ProviderError as error:
        if error.codes == (1553,):
            return {}  # An explicit provider not-found is an absent association.
        raise
