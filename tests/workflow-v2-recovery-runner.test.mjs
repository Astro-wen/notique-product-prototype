import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/recover-background-jobs.yml', import.meta.url), 'utf8');
const start = workflow.indexOf('          import json\n');
const end = workflow.lastIndexOf('          PY\n');
assert.ok(start >= 0 && end > start, 'the runnable recovery Python block must exist');
const python = workflow.slice(start, end).split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');

test('background recovery keeps its schedule, serialized runs, fixed credentials, and bounded job', () => {
  assert.match(workflow, /cron: '2-59\/5 \* \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /group: notique-background-recovery\s*\n\s+cancel-in-progress: false/);
  assert.match(workflow, /NOTIQUE_RECOVERY_TOKEN: \$\{\{ secrets\.NOTIQUE_RECOVERY_TOKEN \}\}/);
  assert.match(workflow, /timeout-minutes: 8/);
  assert.match(workflow, /MAX_RECOVERY_SECONDS = 360/);
  assert.equal((workflow.match(/- name:/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /uses:|checkout|npm |pip |INTERNAL_JOB_TOKEN|AI_API_KEY/);
});

test('native scheduled recovery consumes submitted work with the same commissioning boundary', () => {
  const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8');
  const scheduled = worker.slice(worker.indexOf('  scheduled('));
  assert.match(scheduled, /sweepAndDispatch\(\{ commission: false \}\)/);
  assert.match(scheduled, /sweepAndDispatchEventAiArtifacts\(\)/);
  assert.match(scheduled, /dispatchWorkflowOutbox\(\)/);
  assert.doesNotMatch(scheduled, /sweepAndDispatch\(\)|ensureAutomaticExtractionRuns|createExtractionRun/);
});

test('the actual inline client resumes pending work, bounds time and retries, and keeps logs private', () => {
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

def body(results=None, states=None, extra=None):
    queues = {name: {'state': 'succeeded', 'result': {'text': private}} for name in names}
    for name, result in (results or {}).items():
        queues[name]['result'].update(result)
    for name, state in (states or {}).items():
        queues[name]['state'] = state
    queues.update(extra or {})
    return json.dumps({'data': {'queues': queues}, 'source_text': private}).encode()

class Clock:
    def __init__(self):
        self.now = 0
        self.delays = []
    def read(self):
        return self.now
    def sleep(self, seconds):
        self.delays.append(seconds)
        self.now += seconds

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
    def __init__(self, results, clock):
        self.results, self.requests, self.clock = list(results), [], clock
    def open(self, request, timeout):
        self.requests.append((request, timeout))
        result = self.results.pop(0)
        if isinstance(result, tuple):
            elapsed, result = result
            assert elapsed <= timeout
            self.clock.now += elapsed
        if isinstance(result, Exception):
            raise result
        return result

def run(results, token=private):
    clock, output = Clock(), io.StringIO()
    opener = Opener(results, clock)
    with contextlib.redirect_stdout(output):
        result = main(opener=opener, sleeper=clock.sleep, token=token, clock=clock.read)
    assert private not in output.getvalue()
    for request, timeout in opener.requests:
        assert request.full_url == endpoint
        assert request.get_method() == 'POST'
        assert request.data == b'{}'
        assert request.get_header('Authorization') == 'Bearer ' + token
        assert request.get_header('User-agent') == 'Notique-Recovery/1.0'
        assert 0 < timeout <= 120
    assert clock.now <= 360
    return result, opener, clock, output.getvalue()

def quiet():
    return Response(200, body())

def pending():
    return Response(200, body({'workflow': {'claimed': 1, 'pending': 1}}))

class ClientTests(unittest.TestCase):
    def test_two_quiet_sweeps_are_spaced_before_idle(self):
        result, opener, clock, output = run([quiet(), quiet()])
        self.assertEqual(result, 0)
        self.assertEqual(len(opener.requests), 2)
        self.assertEqual(clock.delays, [12])
        self.assertIn('recovery_state=pending http_status=200 attempt=1', output)
        self.assertTrue(output.endswith('recovery_state=idle http_status=200 attempt=1\n'))
        self.assertNotIn('recovery_state=succeeded', output)

    def test_pending_provider_response_is_resumed_without_new_request_body(self):
        result, opener, clock, output = run([pending(), pending(), Response(200, body({'workflow': {'claimed': 1, 'succeeded': 1}})), quiet(), quiet()])
        self.assertEqual(result, 0)
        self.assertEqual(len(opener.requests), 5)
        self.assertEqual(clock.delays, [12] * 4)
        self.assertIn('recovery_queue=workflow state=succeeded claimed=1 pending=1', output)
        self.assertIn('recovery_queue=workflow state=succeeded claimed=1 succeeded=1', output)

    def test_upstream_activity_and_nested_deferred_work_keep_resuming(self):
        cases = (
            {'extraction': {'dispatch': {'claimed': 1, 'sent': 1}}},
            {'extraction': {'dispatch': {'deferred': 1}}},
            {'extraction': {'transcription_dispatch': {'deferred': 1}}},
            {'extraction': {'sweep': {'recoveredOutbox': 1}}},
            {'extraction': {'transcription_sweep': {'requeuedExpiredRuns': 1}}},
            {'event_ai_artifacts': {'dispatch': {'pending': 1}}},
            {'event_ai_artifacts': {'recovered': 1}},
            {'workflow': {'obsolete': 1}},
            {'workflow': {'lostLease': 1}},
        )
        for counts in cases:
            with self.subTest(counts=counts):
                result, opener, clock, _ = run([Response(200, body(counts)), quiet(), quiet()])
                self.assertEqual(result, 0)
                self.assertEqual(len(opener.requests), 3)
                self.assertEqual(clock.delays, [12, 12])

    def test_downstream_job_after_first_quiet_sweep_resets_quiet_window(self):
        result, opener, clock, _ = run([quiet(), pending(), quiet(), quiet()])
        self.assertEqual(result, 0)
        self.assertEqual(len(opener.requests), 4)
        self.assertEqual(clock.delays, [12, 12, 12])

    def test_six_minute_deadline_is_pending_and_has_no_more_calls(self):
        result, opener, clock, output = run([pending() for _ in range(30)])
        self.assertEqual(result, 2)
        self.assertEqual(len(opener.requests), 30)
        self.assertEqual(clock.now, 360)
        self.assertEqual(opener.requests[-1][1], 12)
        self.assertTrue(output.endswith('recovery_state=pending reason=deadline\n'))
        self.assertNotIn('recovery_state=idle', output)

    def test_http_timeout_uses_remaining_budget(self):
        result, opener, clock, output = run([(120, pending()), (120, pending()), (80, pending()), (4, TimeoutError(private))])
        self.assertEqual(result, 2)
        self.assertEqual([timeout for _, timeout in opener.requests], [120, 120, 96, 4])
        self.assertEqual(clock.now, 360)
        self.assertTrue(output.endswith('recovery_state=pending reason=deadline\n'))

    def test_retry_after_and_partial_queue_failure(self):
        failure = json.dumps({'error': {'message': private, 'details': {'queues': {'workflow': {'state': 'failed', 'result': {'failed': 1}}, 'extraction': {'state': 'succeeded'}, 'event_ai_artifacts': {'state': 'succeeded'}}}}}).encode()
        error = urllib.error.HTTPError(endpoint, 503, private, {'Retry-After': '30'}, io.BytesIO(failure))
        result, opener, clock, output = run([error, quiet(), quiet()])
        self.assertEqual(result, 0)
        self.assertEqual(len(opener.requests), 3)
        self.assertEqual(clock.delays, [30, 12])
        self.assertIn('recovery_queue=workflow state=failed failed=1', output)

    def test_network_failure_has_three_attempts(self):
        result, opener, clock, output = run([urllib.error.URLError(private) for _ in range(3)])
        self.assertEqual(result, 1)
        self.assertEqual(len(opener.requests), 3)
        self.assertEqual(clock.delays, [10, 20])
        self.assertIn('http_status=0 attempt=3', output)

    def test_retry_counter_resets_after_an_accepted_sweep(self):
        result, opener, clock, _ = run([urllib.error.URLError(private), pending(), urllib.error.URLError(private), quiet(), quiet()])
        self.assertEqual(result, 0)
        self.assertEqual(len(opener.requests), 5)
        self.assertEqual(clock.delays, [10, 12, 10, 12])

    def test_error_breaks_the_quiet_window(self):
        result, opener, clock, _ = run([quiet(), urllib.error.URLError(private), quiet(), quiet()])
        self.assertEqual(result, 0)
        self.assertEqual(len(opener.requests), 4)
        self.assertEqual(clock.delays, [12, 10, 12])

    def test_terminal_task_failure_is_not_reported_idle(self):
        cases = (
            {'workflow': {'failed': 1}},
            {'event_ai_artifacts': {'dispatch': {'failed': 1}}},
            {'extraction': {'sweep': {'failedUndeliverableRuns': 1}}},
            {'extraction': {'transcription_sweep': {'deadLetteredExhaustedPending': 1}}},
        )
        for counts in cases:
            with self.subTest(counts=counts):
                result, opener, clock, output = run([Response(200, body(counts))])
                self.assertEqual(result, 1)
                self.assertEqual(len(opener.requests), 1)
                self.assertEqual(clock.delays, [])
                self.assertIn('recovery_state=failed http_status=200', output)
                self.assertNotIn('recovery_state=idle', output)

    def test_auth_failure_is_not_retried(self):
        for status in (401, 403):
            error = urllib.error.HTTPError(endpoint, status, private, {}, io.BytesIO(private.encode()))
            result, opener, clock, _ = run([error])
            self.assertEqual(result, 1)
            self.assertEqual(len(opener.requests), 1)
            self.assertEqual(clock.delays, [])

    def test_redirect_does_not_forward_authorization(self):
        request = urllib.request.Request(endpoint, headers={'Authorization': 'Bearer ' + private}, method='POST')
        target = 'https://untrusted.invalid/collect'
        self.assertIsNone(namespace['NoRedirect']().redirect_request(request, None, 302, private, {'Location': target}, target))
        error = urllib.error.HTTPError(endpoint, 302, private, {'Location': target}, io.BytesIO(private.encode()))
        result, opener, clock, _ = run([error])
        self.assertEqual(result, 1)
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(clock.delays, [])

    def test_rate_limit_delay_is_bounded(self):
        errors = [urllib.error.HTTPError(endpoint, 429, private, {'Retry-After': '60000'}, io.BytesIO(b'{}')) for _ in range(3)]
        result, opener, clock, _ = run(errors)
        self.assertEqual(result, 1)
        self.assertEqual(len(opener.requests), 3)
        self.assertEqual(clock.delays, [60, 60])

    def test_retry_sleep_is_clamped_by_six_minute_deadline(self):
        errors = [(120, urllib.error.HTTPError(endpoint, 429, private, {'Retry-After': '60'}, io.BytesIO(b'{}'))) for _ in range(2)]
        result, opener, clock, output = run(errors)
        self.assertEqual(result, 2)
        self.assertEqual(len(opener.requests), 2)
        self.assertEqual(clock.delays, [60, 60])
        self.assertEqual(clock.now, 360)
        self.assertTrue(output.endswith('recovery_state=pending reason=deadline\n'))

    def test_invalid_or_oversize_success_fails_without_body_output(self):
        for raw in (private.encode(), b'x' * (namespace['MAX_BODY_BYTES'] + 1), b'[' * 1100 + b'0' + b']' * 1100, b'{"number":' + b'9' * 5000 + b'}'):
            result, opener, clock, _ = run([Response(200, raw)])
            self.assertEqual(result, 1)
            self.assertEqual(len(opener.requests), 1)
            self.assertEqual(clock.delays, [])

    def test_untrusted_names_and_states_are_filtered(self):
        raw = body(states={'workflow': private}, extra={private: {'state': private, 'result': {'claimed': private}}})
        result, opener, _, output = run([Response(200, raw)])
        self.assertEqual(result, 1)
        self.assertEqual(len(opener.requests), 1)
        self.assertIn('recovery_queue=workflow state=unknown', output)

    def test_untrusted_nested_counts_cannot_keep_a_run_alive_or_leak(self):
        invalid = {'claimed': True, 'sent': -1, 'deferred': 1.2, 'failed': private, 'pending': 9007199254740992}
        raw = body({'extraction': {'dispatch': invalid}, 'workflow': invalid, 'event_ai_artifacts': {'dispatch': invalid}})
        result, opener, clock, output = run([Response(200, raw), quiet()])
        self.assertEqual(result, 0)
        self.assertEqual(len(opener.requests), 2)
        self.assertEqual(clock.delays, [12])
        self.assertIn('recovery_queue=extraction state=succeeded\n', output)

    def test_missing_token_starts_no_request(self):
        result, opener, clock, output = run([], token='')
        self.assertEqual(result, 1)
        self.assertEqual(opener.requests, [])
        self.assertEqual(clock.delays, [])
        self.assertEqual(output, 'recovery_state=failed configured=0\n')

unittest.main(argv=['recovery-test'], verbosity=1)
`;
  const result = spawnSync('python3', ['-c', harness], { input: python, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 19 tests/);
});
