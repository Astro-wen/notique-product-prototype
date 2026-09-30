import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/recover-background-jobs.yml', import.meta.url), 'utf8');
const start = workflow.indexOf('          import json\n');
const end = workflow.lastIndexOf('          PY\n');
assert.ok(start >= 0 && end > start, 'the runnable recovery Python block must exist');
const python = workflow.slice(start, end).split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');

test('background recovery schedule is serialized, uses only its secret, and needs no checkout or dependency install', () => {
  assert.match(workflow, /cron: '2-59\/5 \* \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /group: notique-background-recovery\s*\n\s+cancel-in-progress: false/);
  assert.match(workflow, /NOTIQUE_RECOVERY_TOKEN: \$\{\{ secrets\.NOTIQUE_RECOVERY_TOKEN \}\}/);
  assert.equal((workflow.match(/- name:/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /uses:|checkout|npm |pip |INTERNAL_JOB_TOKEN|AI_API_KEY/);
});

test('the actual inline recovery client bounds retries, refuses redirects, and emits only safe queue statistics', () => {
  const harness = String.raw`
import contextlib
import io
import json
import sys
import unittest
import urllib.error
import urllib.request

namespace = {'__name__': 'recovery_test'}
exec(compile(sys.stdin.read(), 'recovery-workflow.py', 'exec'), namespace)
main = namespace['main']
endpoint = namespace['ENDPOINT']
names = namespace['QUEUES']
private = 'SYNTHETIC_PRIVATE_BODY_AND_TOKEN'

def body(states=None, extra=None):
    queues = {name: {'state': 'succeeded', 'result': {'claimed': 2, 'sent': 1, 'text': private}} for name in names}
    if states:
        for name, state in states.items():
            queues[name]['state'] = state
    if extra:
        queues.update(extra)
    return json.dumps({'data': {'queues': queues}, 'source_text': private}).encode()

class Response:
    def __init__(self, status, raw, headers=None):
        self.status, self.raw, self.headers = status, raw, headers or {}
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def read(self, limit):
        return self.raw[:limit]

class Opener:
    def __init__(self, results):
        self.results, self.requests = list(results), []
    def open(self, request, timeout):
        self.requests.append((request, timeout))
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

def run(results, token=private):
    opener, delays, output = Opener(results), [], io.StringIO()
    with contextlib.redirect_stdout(output):
        result = main(opener=opener, sleeper=delays.append, token=token)
    assert private not in output.getvalue()
    for request, timeout in opener.requests:
        assert request.full_url == endpoint
        assert request.get_method() == 'POST'
        assert request.data == b'{}'
        assert request.get_header('Authorization') == 'Bearer ' + token
        assert request.get_header('User-agent') == 'Notique-Recovery/1.0'
        assert timeout == 120
    return result, opener, delays, output.getvalue()

class ClientTests(unittest.TestCase):
    def test_success_fixed_endpoint_and_counts(self):
        result, opener, delays, output = run([Response(200, body())])
        self.assertEqual(result, 0)
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(delays, [])
        self.assertIn('recovery_queue=workflow state=succeeded claimed=2 sent=1', output)

    def test_retry_after_and_partial_failure(self):
        failure = json.dumps({'error': {'message': private, 'details': {'queues': {'workflow': {'state': 'failed', 'result': {'failed': 1}}, 'extraction': {'state': 'succeeded'}, 'event_ai_artifacts': {'state': 'succeeded'}}}}}).encode()
        error = urllib.error.HTTPError(endpoint, 503, private, {'Retry-After': '30'}, io.BytesIO(failure))
        result, opener, delays, output = run([error, Response(200, body())])
        self.assertEqual(result, 0)
        self.assertEqual(len(opener.requests), 2)
        self.assertEqual(delays, [30])
        self.assertIn('recovery_queue=workflow state=failed failed=1', output)

    def test_network_failure_has_three_attempts(self):
        result, opener, delays, output = run([urllib.error.URLError(private) for _ in range(3)])
        self.assertEqual(result, 1)
        self.assertEqual(len(opener.requests), 3)
        self.assertEqual(delays, [10, 20])
        self.assertIn('http_status=0 attempt=3', output)

    def test_auth_failure_is_not_retried(self):
        for status in (401, 403):
            error = urllib.error.HTTPError(endpoint, status, private, {}, io.BytesIO(private.encode()))
            result, opener, delays, _ = run([error])
            self.assertEqual(result, 1)
            self.assertEqual(len(opener.requests), 1)
            self.assertEqual(delays, [])

    def test_redirect_does_not_forward_authorization(self):
        request = urllib.request.Request(endpoint, headers={'Authorization': 'Bearer ' + private}, method='POST')
        target = 'https://untrusted.invalid/collect'
        self.assertIsNone(namespace['NoRedirect']().redirect_request(request, None, 302, private, {'Location': target}, target))
        error = urllib.error.HTTPError(endpoint, 302, private, {'Location': target}, io.BytesIO(private.encode()))
        result, opener, delays, _ = run([error])
        self.assertEqual(result, 1)
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(delays, [])

    def test_rate_limit_is_bounded(self):
        errors = [urllib.error.HTTPError(endpoint, 429, private, {'Retry-After': '60000'}, io.BytesIO(b'{}')) for _ in range(3)]
        result, opener, delays, _ = run(errors)
        self.assertEqual(result, 1)
        self.assertEqual(len(opener.requests), 3)
        self.assertEqual(delays, [60, 60])

    def test_invalid_or_oversize_success_fails_without_body_output(self):
        for raw in (private.encode(), b'x' * (namespace['MAX_BODY_BYTES'] + 1), b'[' * 1100 + b'0' + b']' * 1100, b'{"number":' + b'9' * 5000 + b'}'):
            result, opener, delays, _ = run([Response(200, raw)])
            self.assertEqual(result, 1)
            self.assertEqual(len(opener.requests), 1)
            self.assertEqual(delays, [])

    def test_untrusted_names_states_and_counts_are_filtered(self):
        raw = body({'workflow': private}, {private: {'state': private, 'result': {'claimed': private}}})
        payload = json.loads(raw)
        payload['data']['queues']['extraction']['result'] = {'claimed': True, 'sent': -1, 'deferred': 1.2, 'failed': private, 'pending': 9007199254740992}
        result, opener, delays, output = run([Response(200, json.dumps(payload).encode())])
        self.assertEqual(result, 1)
        self.assertIn('recovery_queue=workflow state=unknown', output)
        self.assertIn('recovery_queue=extraction state=succeeded\n', output)

    def test_missing_token_starts_no_request(self):
        result, opener, delays, output = run([], token='')
        self.assertEqual(result, 1)
        self.assertEqual(opener.requests, [])
        self.assertEqual(delays, [])
        self.assertEqual(output, 'recovery_state=failed configured=0\n')

unittest.main(argv=['recovery-test'], verbosity=1)
`;
  const result = spawnSync('python3', ['-c', harness], { input: python, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 9 tests/);
});
