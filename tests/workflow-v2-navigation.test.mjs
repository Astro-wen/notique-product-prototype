import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationOrder, conversationDate, conversationLabels, conversationCaption } from '../lib/domain/conversation-navigation.ts';

test('real upload timestamp takes priority over event creation and historical meeting dates',()=>{
  const event={id:'bank',title:'Citizen Bank · 会议日期待核对',occurredAt:'2026-09-23T12:00:00Z',createdAt:'2026-10-01T12:00:00Z',uploadedAt:'2026-10-06T12:00:00Z'};
  assert.equal(conversationDate(event),'10/06');
  assert.equal(conversationCaption(event,conversationLabels([event]).get(event.id)),'10/06 · Citizen Bank');
  assert.equal(event.occurredAt,'2026-09-23T12:00:00Z');
});

test('import labels display the upload date and remove pending-date boilerplate without changing stored titles',()=>{
  const pending={id:'bank',title:'Citi Bank · 会议日期待核对',occurredAt:'2026-10-06T12:00:00Z'};
  assert.equal(conversationDate(pending),'10/06');
  assert.equal(conversationCaption(pending,pending.title),'10/06 · Citi Bank');
  assert.equal(pending.title,'Citi Bank · 会议日期待核对');
  const dated={id:'workshop',title:'09/23 · 活动初步安排',occurredAt:'2026-09-23T14:00:00Z'};
  assert.equal(conversationCaption(dated,dated.title),dated.title);
  assert.equal(conversationCaption(dated,'活动初步安排'),'09/23 · 活动初步安排');
});

test('conversation navigation follows upload order and leaves shared state intact', () => {
  const events = Object.freeze([
    { id: 'latest', occurredAt: '2026-10-01T09:00:00Z', createdAt: '2026-10-01T10:00:00Z' },
    { id: 'earliest', occurredAt: '2026-09-18T09:00:00Z', createdAt: '2026-10-02T10:00:00Z' },
    { id: 'middle', occurredAt: '2026-09-24T09:00:00Z', createdAt: '2026-10-03T10:00:00Z' },
  ]);
  assert.deepEqual(conversationOrder(events).map(x => x.id), ['latest', 'earliest', 'middle']);
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
  assert.equal(conversationDate({ id: 'missing' }), '—');
});

test('duplicate default conversation titles are distinguishable in every source entry', () => {
  const events = [
    { id: 'second', title: '第一条记录', occurredAt: '2026-10-02T10:00:00Z' },
    { id: 'first', title: '第一条记录', occurredAt: '2026-10-02T09:00:00Z' },
  ];
  const labels = conversationLabels(events);
  assert.equal(labels.get('first'), '对话 01');
  assert.equal(labels.get('second'), '对话 02');
  assert.deepEqual(conversationLabels(events.toReversed()), labels);
  assert.equal(events[0].title, '第一条记录');
});

test('distinct custom titles are preserved while repeated titles and missing titles remain distinguishable', () => {
  const labels = conversationLabels([
    { id: 'a', title: '预算讨论' }, { id: 'b', title: '预算讨论' },
    { id: 'c', title: '方案定稿' }, { id: 'd' },
  ]);
  assert.deepEqual([...labels.values()], ['对话 01 · 预算讨论', '对话 02 · 预算讨论', '方案定稿', '对话 04']);
});
