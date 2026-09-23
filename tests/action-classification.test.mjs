import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyActionStatement } from '../lib/domain/action-classification.ts';
test('financing status stays a fact, concrete future tasks stay actions', () => {
  assert.equal(classifyActionStatement('next_action', 'The buyer has not yet obtained pre-approval or spoken with a lender.'), 'property_fact');
  assert.equal(classifyActionStatement('next_action', '客户尚未获得贷款预批。'), 'property_fact');
  for (const text of ['The agent will contact the lender.', 'The buyer has not yet obtained pre-approval and will contact the lender tomorrow.', 'Schedule showings for the selected homes.', 'Contact the lender who has not yet approved the buyer.']) assert.equal(classifyActionStatement('next_action', text), 'next_action');
  assert.equal(classifyActionStatement('open_question', 'The buyer has not yet obtained pre-approval.'), 'open_question');
});

test('legacy correction preserves accepted, human, and mixed future-action records', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFile } = await import('node:fs/promises');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE claims(id TEXT, type TEXT, source TEXT, review_status TEXT, current_version_id TEXT, updated_at TEXT); CREATE TABLE claim_versions(id TEXT, statement TEXT);');
  const statement = 'The buyer has not yet obtained pre-approval or spoken with a lender.';
  for (const [id, source, status, text] of [['pending','ai','pending',statement],['verified','ai','verified',statement],['human','human','pending',statement],['mixed','ai','pending',statement+' The agent will call tomorrow.']]) {
    db.prepare('INSERT INTO claims VALUES (?, ?, ?, ?, ?, ?)').run(id,'next_action',source,status,id,'before');
    db.prepare('INSERT INTO claim_versions VALUES (?, ?)').run(id,text);
  }
  db.exec(await readFile(new URL('../drizzle/0017_financing_status_classification.sql',import.meta.url),'utf8'));
  assert.equal(db.prepare('SELECT type FROM claims WHERE id=?').get('pending').type,'property_fact');
  for (const id of ['verified','human','mixed']) assert.equal(db.prepare('SELECT type FROM claims WHERE id=?').get(id).type,'next_action');
  assert.equal(db.prepare('SELECT statement FROM claim_versions WHERE id=?').get('pending').statement,statement);
});
