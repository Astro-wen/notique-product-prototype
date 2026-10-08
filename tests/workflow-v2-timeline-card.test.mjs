import assert from 'node:assert/strict';
import test from 'node:test';
import {timelineLabel,timelineValues} from '../lib/domain/timeline-card.ts';

test('only cross-conversation comparisons receive change labels',()=>{
  for(const entry of [
    {kind:'conflict',proposalType:'changed'},
    {kind:'updated'},
  ])assert.equal(timelineLabel(entry),'说法变化');
  assert.equal(timelineLabel({kind:'conflict',proposalType:'conflicting'}),'表述不同');
  assert.equal(timelineLabel({kind:'introduced'}),'首次记录');
  assert.equal(timelineLabel({kind:'introduced',sourceDiff:{before:'a',after:'b'}}),'首次记录');
  assert.equal(timelineLabel({kind:'repeated'}),'再次提及');
  assert.equal(timelineLabel({kind:'conflict',proposalType:'possibly_answered'}),'有了回答');
  assert.equal(timelineLabel({kind:'resolved'}),'有了回答');
});

test('compact preview retains exact budget, date and count values from the two statements',()=>{
  assert.deepEqual(timelineValues('Total budget $15,000.','Raised from $15,000 to $18,000.','金额'),{before:'$15,000',after:'$18,000'});
  assert.deepEqual(timelineValues('October 18, 2026 at 2 p.m.','October 18, 2026 moved to October 20, 2026.','日期'),{before:'October 18, 2026',after:'October 20, 2026'});
  assert.deepEqual(timelineValues('October 18, 2026 at 2 p.m.','Moved from October 18, 2026 to October 20, 2026; use October 20.','日期'),{before:'October 18, 2026',after:'October 20, 2026'});
  assert.deepEqual(timelineValues('Plan for 30 participants.','Count increased from 30 to 40.','数量'),{before:'30',after:'40'});
  assert.deepEqual(timelineValues('预算15万元','预算18万元','金额'),{before:'15万元',after:'18万元'});
  assert.deepEqual(timelineValues('Total $15k','Total $18k','金额'),{before:'$15k',after:'$18k'});
  assert.deepEqual(timelineValues('Price $1.3-million','Price $1.4-million','金额'),{before:'$1.3-million',after:'$1.4-million'});
});

test('ambiguous values, unchanged values and unrelated categories keep their original wording',()=>{
  assert.equal(timelineValues('Budget $15,000, venue $2,000.','Budget $18,000.','金额'),null);
  assert.equal(timelineValues('$15,000','$18,000 plus $500.','金额'),null);
  assert.equal(timelineValues('30 people','30 people','数量'),null);
  assert.equal(timelineValues('Room 30 for 20 people','Room 40 for 30 people','数量'),null);
  assert.equal(timelineValues('We used it before.','We do not use it now.','决定'),null);
  assert.equal(timelineValues('Area 0.17 acres','Area 0.25 acres','数量'),null);
  assert.equal(timelineValues('October 20, 2026','October 20, 2027 and October 20, 2028','日期'),null);
});
