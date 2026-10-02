import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationOrder, conversationDate } from '../lib/domain/conversation-navigation.ts';

test('conversation navigation follows conversation dates rather than import order and leaves shared state intact', () => {
  const events = Object.freeze([
    { id: 'latest', occurredAt: '2026-10-01T09:00:00Z', createdAt: '2026-10-01T10:00:00Z' },
    { id: 'earliest', occurredAt: '2026-09-18T09:00:00Z', createdAt: '2026-10-02T10:00:00Z' },
    { id: 'middle', occurredAt: '2026-09-24T09:00:00Z', createdAt: '2026-10-03T10:00:00Z' },
  ]);
  assert.deepEqual(conversationOrder(events).map(x => x.id), ['earliest', 'middle', 'latest']);
  assert.equal(events[0].id, 'latest');
});

test('legacy conversations use the valid creation date and tied dates have stable navigation', () => {
  const events = [
    { id: 'b', occurredAt: 'bad legacy date', createdAt: '2026-09-18T12:00:00Z' },
    { id: 'a', occurredAt: '2026-09-18T12:00:00Z' },
    { id: 'later', createdAt: '2026-10-01T12:00:00Z' },
  ];
  assert.deepEqual(conversationOrder(events).map(x => x.id), ['a', 'b', 'later']);
  assert.equal(conversationDate(events[0]), conversationDate(events[1]));
  assert.equal(conversationDate({ id: 'missing' }), '日期未设置');
});
