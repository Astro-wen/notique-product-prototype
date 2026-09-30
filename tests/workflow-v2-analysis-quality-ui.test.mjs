import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {parseAnalysisQualityNotes} from '../lib/shared/workflow-v2.ts';

const require = createRequire(import.meta.url);
const componentUrl = new URL('../app/features/workflow/components/analysis-progress.tsx', import.meta.url);

async function loadAnalysisProgress() {
  const source = await readFile(componentUrl, 'utf8');
  // Substitute only the UI primitives and CSS module. The real component's
  // branches and JSX are compiled and rendered by React, including its text
  // escaping; no copy of the progress or quality-message logic lives here.
  const compilable = source
    .replace(/import \{ NqButton, NqStatus \}[^\n]+\n/, `
      const NqButton = ({children}) => React.createElement('button', null, children);
      const NqStatus = ({children}) => React.createElement('span', null, children);
    `)
    .replace(/import styles[^\n]+\n/, "const styles = {analysis: 'analysis', analysisBar: 'analysisBar'};\n");
  assert.notEqual(compilable, source, 'the component dependency substitutions must apply');
  const {outputText} = ts.transpileModule(compilable, {
    compilerOptions: {jsx: ts.JsxEmit.React, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022},
  });
  const reactUrl = pathToFileURL(require.resolve('react')).href;
  const moduleSource = `import React from ${JSON.stringify(reactUrl)};\n${outputText}`;
  return (await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`)).AnalysisProgress;
}

const component = loadAnalysisProgress();
const sourceReviewNotes = {
  omittedStatements: ['第二场培训参加人数尚未确定'],
  inventoryLimitReached: false,
  finalClaimLimitReached: false,
  followUpOmitted: true,
};
function completedRun(qualityNotes) {
  return {
    id: 'synthetic-run', revision: 1, state: 'succeeded', inputRevision: 0, retryable: false,
    stages: [{id: 'inventory', name: '提取重点', state: 'succeeded', retryable: false, errorCode: null}],
    coverage: {totalSegments: 1, completedSegments: 1, complete: true, unprocessedRanges: []},
    ...(qualityNotes ? {qualityNotes} : {}),
  };
}
async function render(run, hasRecord = true) {
  return renderToStaticMarkup(React.createElement(await component, {
    run, hasRecord, busy: false, error: '', canEdit: false,
    onStart() {}, onRetry() {}, onReload() {},
  }));
}
function status(html) {
  const match = html.match(/role="status">([^<]+)</);
  assert.ok(match, 'the actual progress component must render an accessible status');
  return match[1];
}

test('analysis quality statements render hostile source content as React text', async () => {
  const malicious = '<img src="x" onerror="alert(1)"> & <script>evil()</script>';
  const notes = parseAnalysisQualityNotes({...sourceReviewNotes, omittedStatements: [malicious]});
  const html = await render(completedRun(notes));
  assert.match(html, /&lt;img src=&quot;x&quot; onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&amp; &lt;script&gt;evil\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<(?:img|script)\b/i);
  assert.match(html, /aria-label="内容核对提示"/);
});

test('an empty record with known omissions does not claim usable highlights exist', async () => {
  const html = await render(completedRun(sourceReviewNotes), false);
  assert.equal(status(html), '部分内容需回看原文');
  assert.doesNotMatch(html, /重点可用/);
  assert.match(html, /部分问题或跟进事项尚未进入重点/);
  assert.match(html, /第二场培训参加人数尚未确定/);
});

test('existing highlights stay readable while known omissions are shown separately', async () => {
  const html = await render(completedRun(sourceReviewNotes));
  assert.equal(status(html), '重点可用，部分内容需回看原文');
  assert.match(html, /部分问题或跟进事项尚未进入重点/);
  assert.match(html, /原文已处理 1 \/ 1 段/);
});

test('a completed run without quality notes keeps its normal completion status', async () => {
  const html = await render(completedRun());
  assert.equal(status(html), '整理完成');
  assert.doesNotMatch(html, /内容核对提示|需回看原文的内容/);
});

test('output-budget failure explains the useful next step instead of claiming the material changed', async () => {
  const run = completedRun();
  run.state = 'failed';
  run.stages[0] = {...run.stages[0],state:'failed',errorCode:'MODEL_OUTPUT_TOKEN_LIMIT'};
  const html = await render(run,false);
  assert.equal(status(html),'本次整理尚未完成');
  assert.match(html,/这次整理已用完输出容量/);
  assert.match(html,/查看原文，或把材料分成较短的记录再整理/);
  assert.doesNotMatch(html,/当前材料或整理条件有变化/);
});
