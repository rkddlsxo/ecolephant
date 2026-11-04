"""Run the API lifecycle against an isolated, explicitly configured DynamoDB Local."""

from datetime import datetime, timezone
import hashlib
import os
import time
from urllib.parse import urlparse
import unittest
from unittest.mock import patch
from uuid import uuid4

import boto3
from botocore.exceptions import EndpointConnectionError
from botocore.exceptions import ClientError

import test_api_lifecycle as lifecycle
from ecolephant import create_app
from ecolephant.errors import ApiError


@unittest.skipUnless(os.getenv('ECOLEPHANT_TEST_DYNAMO_ENDPOINT'), 'DynamoDB Local endpoint not configured')
class DynamoLifecycleTests(lifecycle.ApiLifecycleTests):
    def setUp(self):
        endpoint = os.environ['ECOLEPHANT_TEST_DYNAMO_ENDPOINT']
        parsed = urlparse(endpoint)
        if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port
                or parsed.path not in {'', '/'} or parsed.query or parsed.fragment
                or parsed.username or parsed.password):
            self.fail('DynamoDB tests require an explicit 127.0.0.1 HTTP endpoint')
        self.endpoint = endpoint
        env = patch.dict(os.environ, {
            'AWS_ACCESS_KEY_ID': 'testing', 'AWS_SECRET_ACCESS_KEY': 'testing',
            'AWS_DEFAULT_REGION': 'ap-northeast-2', 'AWS_EC2_METADATA_DISABLED': 'true',
            'AWS_ENDPOINT_URL_DYNAMODB': endpoint,
        })
        env.start()
        self.addCleanup(env.stop)
        for key in ('AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_SESSION_TOKEN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN'):
            os.environ.pop(key, None)
        self.database_client = boto3.client('dynamodb', endpoint_url=endpoint, region_name='ap-northeast-2',
                                            aws_access_key_id='testing', aws_secret_access_key='testing')
        for attempt in range(40):
            try:
                self.database_client.list_tables(Limit=1)
                break
            except EndpointConnectionError:
                if attempt == 39:
                    raise
                time.sleep(0.25)
        self.table_name = 'ecolephant_test_' + uuid4().hex
        self.database_client.create_table(
            TableName=self.table_name,
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'}, {'AttributeName': 'sk', 'AttributeType': 'S'}],
            BillingMode='PAY_PER_REQUEST',
        )
        self.addCleanup(self.remove_test_table)
        self.app = self.make_app('test-local-token-a')
        self.client = self.app.test_client()
        self.headers = {'Authorization': 'Bearer test-local-token-a'}
        self.started = datetime(2026, 10, 17, 10, tzinfo=timezone.utc)

    def remove_test_table(self):
        if not self.table_name.startswith('ecolephant_test_'):
            raise ValueError('Unexpected test table name')
        self.database_client.delete_table(TableName=self.table_name)

    def make_app(self, token):
        return create_app({
            'TESTING': True, 'AUTH_MODE': 'local', 'LOCAL_TOKEN': token,
            'STORAGE': 'dynamodb', 'TABLE': self.table_name, 'ENDPOINT': self.endpoint,
            'ALLOWED_ORIGIN': 'http://127.0.0.1:5173',
        })

    def test_stale_revision_cannot_overwrite_a_session(self):
        session_id, _, _ = self.create_session()
        owner = 'local-' + hashlib.sha256(b'test-local-token-a').hexdigest()[:24]
        repository = self.app.extensions['repository']
        first = repository.load(owner, session_id)
        stale = repository.load(owner, session_id)
        repository.commit(owner, first)
        with self.assertRaises(ApiError) as caught:
            repository.commit(owner, stale)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.client.get(f'/api/v1/sessions/{session_id}', headers=self.headers).status_code, 200)

    def test_event_read_rejects_revision_change_during_query(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        event = {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 0, 'type': 'paused', 'data': {}}
        self.assertEqual(self.client.post(prefix + '/events:batch', json={'events': [event]}, headers=self.headers).status_code, 200)
        repository = self.app.extensions['repository']
        owner = 'local-' + hashlib.sha256(b'test-local-token-a').hexdigest()[:24]
        original_query = repository.query
        def query_then_change(pk, prefix=''):
            rows = original_query(pk, prefix)
            if prefix == 'event-batch#':
                metadata = repository.load_metadata(owner, session_id)
                repository.commit(owner, metadata)
            return rows
        with patch.object(repository, 'query', side_effect=query_then_change):
            response = self.client.get(prefix + '/events', headers=self.headers)
        self.assertEqual(response.status_code, 409, response.get_json())
        self.assertEqual(self.client.get(prefix + '/events', headers=self.headers).get_json()['items'], [event])

    def test_append_and_detail_skip_sample_queries_and_events_read_only_event_batches(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        first = self.client.post(prefix + '/samples:batch', json={'samples': [lifecycle.sample(1, 10)]}, headers=self.headers)
        self.assertEqual(first.status_code, 200, first.get_json())
        event = {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 0, 'type': 'paused', 'data': {}}
        self.assertEqual(self.client.post(prefix + '/events:batch', json={'events': [event]}, headers=self.headers).status_code, 200)
        repository = self.app.extensions['repository']
        with patch.object(repository, 'query', wraps=repository.query) as queries:
            detail = self.client.get(prefix, headers=self.headers)
            events = self.client.get(prefix + '/events', headers=self.headers)
            added = self.client.post(prefix + '/samples:batch', json={'samples': [lifecycle.sample(2, 35)]}, headers=self.headers)
        self.assertEqual((detail.status_code, events.status_code, added.status_code), (200, 200, 200))
        self.assertEqual(queries.call_count, 1)
        self.assertEqual(queries.call_args.args, ('session#' + session_id, 'event-batch#'))

    def test_timeline_read_rejects_revision_change_during_index_query(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        response = self.client.post(prefix + '/samples:batch',
                                    json={'samples': [lifecycle.sample(seq, 10) for seq in range(1, 61)]}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        repository = self.app.extensions['repository']
        owner = 'local-' + hashlib.sha256(b'test-local-token-a').hexdigest()[:24]
        original = repository.timeline_rows
        def query_then_change(session, low, high):
            rows = original(session, low, high)
            metadata = repository.load_metadata(owner, session_id)
            repository.commit(owner, metadata)
            return rows
        with patch.object(repository, 'timeline_rows', side_effect=query_then_change):
            response = self.client.get(prefix + '/timeline', headers=self.headers)
        self.assertEqual(response.status_code, 409, response.get_json())
        self.assertEqual(self.client.get(prefix + '/timeline', headers=self.headers).status_code, 200)

    def test_maximum_batch_and_delete_remove_derived_data_and_events(self):
        session_id, _, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        batch = {'samples': [lifecycle.sample(seq, 10) for seq in range(1, 61)]}
        response = self.client.post(prefix + '/samples:batch', json=batch, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()['acknowledged_through_seq'], 60)
        event = {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 0, 'type': 'paused', 'data': {}}
        response = self.client.post(prefix + '/events:batch', json={'events': [event]}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        repository = self.app.extensions['repository']
        self.assertEqual(len(repository.query('session#' + session_id)), 62)
        self.assertEqual(len(repository.query('session#' + session_id, 'timeline#')), 1)
        self.assertEqual(self.client.delete(prefix, headers=self.headers).status_code, 204)
        self.assertEqual(repository.query('session#' + session_id), [])
        self.assertIsNone(repository.get('event#' + event['event_id'], 'identity'))

    def test_interrupted_delete_cannot_remove_a_reused_identity_from_another_owner(self):
        session_id, payload, _ = self.create_session()
        first_prefix = f'/api/v1/sessions/{session_id}'
        event = {'event_id': str(uuid4()), 'event_seq': 1, 'elapsed_ms': 0, 'type': 'paused', 'data': {}}
        self.assertEqual(self.client.post(first_prefix + '/events:batch',
                         json={'events': [event]}, headers=self.headers).status_code, 200)
        repository = self.app.extensions['repository']
        owner = 'local-' + hashlib.sha256(b'test-local-token-a').hexdigest()[:24]
        meta_key = {'pk': 'owner#' + owner, 'sk': 'session#' + session_id}
        meta = repository.get(meta_key['pk'], meta_key['sk'])
        # A partial cleanup has removed the old identity but left its event batch for retry.
        repository.table.update_item(Key=meta_key, UpdateExpression='SET deleted=:deleted, body=:body, revision=:revision',
                                     ExpressionAttributeValues={':deleted': True, ':body': '{}',
                                                                ':revision': int(meta['revision']) + 1})
        repository.table.delete_item(Key={'pk': 'event#' + event['event_id'], 'sk': 'identity'})
        other = self.make_app('test-local-token-b').test_client()
        other_headers = {'Authorization': 'Bearer test-local-token-b', 'Idempotency-Key': str(uuid4())}
        other_payload = {**payload, 'client_session_id': str(uuid4())}
        created = other.post('/api/v1/sessions', json=other_payload, headers=other_headers)
        self.assertEqual(created.status_code, 201, created.get_json())
        other_id = created.get_json()['id']
        other_prefix = f'/api/v1/sessions/{other_id}'
        received = other.post(other_prefix + '/events:batch', json={'events': [event]}, headers=other_headers)
        self.assertEqual(received.status_code, 200, received.get_json())
        self.assertEqual(self.client.delete(first_prefix, headers=self.headers).status_code, 204)
        identity = repository.get('event#' + event['event_id'], 'identity')
        self.assertIsNotNone(identity, 'Cleanup removed an event identity now owned by another session')
        self.assertEqual(identity['session_id'], other_id)
        self.assertEqual(repository.query('session#' + session_id), [])
        self.assertEqual(len(other.get(other_prefix + '/events', headers=other_headers).get_json()['items']), 1)

    def test_failed_cleanup_retains_its_batch_and_retry_preserves_reassigned_identity(self):
        session_id, payload, _ = self.create_session()
        prefix = f'/api/v1/sessions/{session_id}'
        events = [{'event_id': str(uuid4()), 'event_seq': seq, 'elapsed_ms': 0, 'type': 'paused', 'data': {}}
                  for seq in (1, 2)]
        response = self.client.post(prefix + '/events:batch', json={'events': events}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.get_json())
        repository = self.app.extensions['repository']
        owner = 'local-' + hashlib.sha256(b'test-local-token-a').hexdigest()[:24]
        original_delete = repository.table.delete_item
        def failing_delete(**kwargs):
            if kwargs['Key']['pk'] == 'event#' + events[1]['event_id']:
                raise ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'synthetic'}}, 'DeleteItem')
            return original_delete(**kwargs)
        with patch.object(repository.table, 'delete_item', side_effect=failing_delete):
            with self.assertRaises(ApiError) as caught:
                repository.delete(owner, session_id)
        self.assertEqual(caught.exception.status, 503)
        self.assertTrue(repository.get('owner#' + owner, 'session#' + session_id)['deleted'])
        self.assertEqual(len(repository.query('session#' + session_id)), 1)
        self.assertIsNone(repository.get('event#' + events[0]['event_id'], 'identity'))
        other = self.make_app('test-local-token-b').test_client()
        other_headers = {'Authorization': 'Bearer test-local-token-b', 'Idempotency-Key': str(uuid4())}
        other_payload = {**payload, 'client_session_id': str(uuid4())}
        created = other.post('/api/v1/sessions', json=other_payload, headers=other_headers)
        self.assertEqual(created.status_code, 201, created.get_json())
        other_id = created.get_json()['id']
        received = other.post(f'/api/v1/sessions/{other_id}/events:batch',
                              json={'events': [events[0]]}, headers=other_headers)
        self.assertEqual(received.status_code, 200, received.get_json())
        repository.delete(owner, session_id)
        self.assertEqual(repository.query('session#' + session_id), [])
        self.assertEqual(repository.get('event#' + events[0]['event_id'], 'identity')['session_id'], other_id)
        self.assertIsNone(repository.get('event#' + events[1]['event_id'], 'identity'))
