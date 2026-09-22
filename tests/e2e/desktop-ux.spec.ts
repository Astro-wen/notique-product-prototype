import { expect, test } from '@playwright/test';
import { NotiqueApiFixture } from './notique-api-fixture';

test('reading views show question answers and actual speaker summaries with raw-only source recall', async ({page}) => {
  const fixture = new NotiqueApiFixture();
  fixture.enableSummaryFirstFlow(); fixture.completeSummary(); fixture.completeFacts(); fixture.completeReadableTranscript();
  await fixture.install(page);
  await page.goto('/?project=project-a&event=event-a&view=simple&readingTab=readable');
  await expect(page.locator('.raw-artifact')).toBeVisible();
  await expect(page.locator('.transcript-subtabs, .tingwu-keywords, .readable-artifact')).toHaveCount(0);
  await page.getByRole('button', {name:'要点回顾',exact:true}).click();
  await expect(page.locator('.tingwu-point')).toHaveCount(3);
  await expect(page.locator('.tingwu-point h3').first()).toHaveText('买家的预算是多少？');
  await expect(page.locator('.tingwu-point p').first()).toContainText('预算上限');
  await page.getByRole('button',{name:/展开全部要点/}).click();
  await expect(page.locator('.tingwu-point')).toHaveCount(5);
  await page.locator('.tingwu-point').first().hover();
  await page.locator('.tingwu-recall').first().click();
  await expect(page.locator('.raw-artifact .transcript-turn.selected').first()).toBeVisible();
  await page.getByRole('button', {name:'发言总结',exact:true}).click();
  await expect(page.locator('.tingwu-speaker-summaries p')).toContainText('买家说明了预算要求');
  await expect(page.locator('.tingwu-speaker-summaries')).not.toContainText('段 ·');
  expect(fixture.writes.filter(write=>!['/api/v1/jobs/dispatch','/api/v1/projects/project-a/opened'].includes(write.path))).toEqual([]);
});

for (const width of [1024, 1440, 1920]) {
  test(`overview fits and uses the desktop window at ${width}px`, async ({page}) => {
    const fixture = new NotiqueApiFixture();
    await fixture.install(page);
    await page.setViewportSize({width,height:1000});
    await page.goto('/?project=project-a&view=results&tab=client-progress');
    await expect(page.locator('.project-overview')).toBeVisible();
    const dimensions=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth,page:document.querySelector('.results-page')!.getBoundingClientRect().width,content:document.querySelector('.result-content')!.getBoundingClientRect().width}));
    expect(dimensions.scroll).toBeLessThanOrEqual(width+1);
    expect(dimensions.page).toBeGreaterThan(width-350);
    expect(dimensions.content).toBeGreaterThan(450);
  });
}

test('workspace Modify opens an editable field without a second Modify click', async ({page}) => {
  const fixture = new NotiqueApiFixture();
  fixture.enableSummaryFirstFlow();
  fixture.completeSummary();
  fixture.completeFacts();
  await fixture.install(page);
  await page.goto('/?project=project-a&event=event-a&view=simple');
  await page.locator('.rail-pending-list button').filter({hasText:'预算上限是 120 万美元'}).click();
  await page.locator('.rail-quick-verdict').getByRole('button',{name:'修改',exact:true}).click();
  await expect(page.locator('.edit-form textarea').first()).toBeVisible();
  await expect(page.locator('.edit-form textarea').first()).toHaveValue('预算上限是 120 万美元');
  await expect(page.locator('.edit-form textarea').first()).toBeFocused();
  await expect(page).toHaveURL(/view=simple/);
  await expect(page.locator('.reader-action-rail .edit-form')).toBeVisible();
  await page.locator('.edit-form').getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.locator('.selected-point-card')).toContainText('预算上限是 120 万美元');
  expect(fixture.writes.filter(write=>!['/api/v1/jobs/dispatch','/api/v1/projects/project-a/opened'].includes(write.path))).toEqual([]);
});

test('project record search recovers from an empty result and secondary views remain reachable', async ({page}) => {
  const fixture = new NotiqueApiFixture();
  await fixture.install(page);
  await page.goto('/?project=project-a&view=results&tab=client-progress');
  const rows = page.locator('.project-overview-row');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  const title = await rows.first().locator('.overview-record-title').innerText();
  const search = page.getByRole('textbox', {name:'搜索项目记录'});
  await search.fill(title);
  await expect(rows).toHaveCount(1);
  await search.fill('nonexistent-record-xyz');
  await expect(page.getByText('没有找到匹配的记录', {exact:true})).toBeVisible();
  await page.getByRole('button', {name:'显示全部记录',exact:true}).click();
  await expect(search).toHaveValue('');
  await expect(rows).toHaveCount(count);
  await page.locator('.result-nav-secondary > summary').click();
  await page.locator('.result-nav-secondary').getByRole('button',{name:'风险与矛盾'}).click();
  await expect(page).toHaveURL(/tab=risks/);
});

for (const width of [1024, 1440, 1920]) {
  test(`transcript opens first and leaves a usable decision column at ${width}px`, async ({page}) => {
    const fixture = new NotiqueApiFixture();
    fixture.enableSummaryFirstFlow();
    fixture.completeSummary();
    fixture.completeReadableTranscript();
    fixture.completeFacts();
    await fixture.install(page);
    await page.setViewportSize({width,height:800});
    await page.goto('/?project=project-a&event=event-a&view=simple');
    await expect(page.locator('.tingwu-overview-copy')).toBeVisible();
    await expect(page.getByRole('button',{name:'章节速览',exact:true})).toBeVisible();
    await expect(page.locator('.reader-overview')).toHaveJSProperty('tagName','SECTION');
    await expect(page.locator('.transcript-copy-button').first()).toBeVisible();
    await expect(page.locator('.pending-view')).toBeVisible();
    const bounds=await page.evaluate(()=>{
      const left=document.querySelector('.reader-reading-pane')!.getBoundingClientRect();
      const right=document.querySelector('.reader-action-rail')!.getBoundingClientRect();
      return {ratio:right.width/(left.width+right.width),bottom:left.bottom,right:left.right,railLeft:right.left,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    expect(bounds.ratio).toBeGreaterThanOrEqual(.34);
    expect(bounds.ratio).toBeLessThanOrEqual(.41);
    expect(bounds.bottom).toBeLessThanOrEqual(800);
    expect(bounds.right).toBeLessThanOrEqual(bounds.railLeft+1);
    expect(bounds.overflow).toBe(false);
      await page.getByRole('button',{name:'章节速览',exact:true}).click();
    const title=await page.locator('.reader-chapters .chapter-copy > summary').first().innerText();
    await page.getByRole('button',{name:/展开全部章节/}).click();
    await expect(page.locator('.reader-chapters .chapter-copy[open]').first()).toBeVisible();
    await expect(page.locator('.inline-chapter .chapter-copy > summary').filter({hasText:title}).first()).toHaveCount(1);
    await page.locator('.reader-chapters .chapter-time').first().click();
    await expect(page.locator('.raw-artifact .transcript-turn.selected').first()).toBeVisible();
    await expect(page.locator('.reader-audio-player')).toHaveCount(0); // fixture contains no audio; do not show a fake player
  });
}


test('inline review guards evidence, retains edits on failure, and submits the chosen sources', async ({page}) => {
  const fixture = new NotiqueApiFixture(); fixture.enableSummaryFirstFlow(); fixture.completeSummary(); fixture.completeFacts();
  fixture.allowMutation('POST','/api/v1/claims/claim-summary-pending/verdicts');
  await fixture.install(page);
  await page.goto('/?project=project-a&event=event-a&view=simple');
  await page.locator('.rail-pending-list button').filter({hasText:'预算上限是 120 万美元'}).click();
  await page.locator('.reader-reading-scroll').evaluate(e => e.scrollTop = 100);
  const position = await page.locator('.reader-reading-scroll').evaluate(e => e.scrollTop);
  await page.locator('.rail-quick-verdict').getByRole('button',{name:'修改',exact:true}).click();
  const editor = page.locator('.edit-form');
  await expect(editor).toBeVisible();
  expect(await page.locator('.reader-reading-scroll').evaluate(e => e.scrollTop)).toBe(position);
  await editor.getByLabel('修改后的陈述').fill('预算上限调整为 110 万美元');
  await expect(editor.getByRole('button',{name:'保存并确认'})).toBeDisabled();
  await editor.locator('.edit-evidence input').first().check();
  await expect(editor.getByRole('button',{name:'保存并确认'})).toBeEnabled();
  let fail = true;
  await page.route('**/claims/claim-summary-pending/verdicts', async route => {
    if (fail) { fail = false; await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEMPORARILY_UNAVAILABLE',message:'请重试'}})}); }
    else await route.fallback();
  });
  await editor.getByRole('button',{name:'保存并确认'}).click();
  await expect(editor.getByLabel('修改后的陈述')).toHaveValue('预算上限调整为 110 万美元');
  await expect(page.locator('.embedded-review')).toContainText('连不上服务');
  await editor.getByRole('button',{name:'保存并确认'}).click();
  await expect(editor).toHaveCount(0);
  await expect(page).toHaveURL(/view=simple/);
  const write = fixture.writes.find(w=>w.path.endsWith('/verdicts'))!;
  expect(write.body).toMatchObject({action:'edit', edit:{statement:'预算上限调整为 110 万美元',retain_existing_evidence:false}});
});

test('action creation sends owner and deadline with source evidence', async ({page}) => {
  const fixture = new NotiqueApiFixture(); fixture.enableSummaryFirstFlow(); fixture.completeSummary(); fixture.completeFacts();
  for (const path of ['/api/v1/events/event-a/manual-claims','/api/v1/claims/claim-manual-action/evidence-review-attestations','/api/v1/claims/claim-manual-action/verdicts']) fixture.allowMutation('POST',path);
  await fixture.install(page);
  await page.goto('/?project=project-a&event=event-a&view=simple');
  await page.locator('.reader-action-tabs').getByRole('button',{name:/行动/}).click();
  await page.getByRole('button',{name:'从当前重点建立行动'}).click();
  const form = page.locator('.rail-action-composer');
  await form.getByLabel('要完成什么').fill('发送三套候选房源');
  await form.getByLabel('负责人（可选）').fill('Kyle');
  await form.getByLabel('截止日期（可选）').fill('2026-10-01');
  await form.getByRole('button',{name:'确认并加入行动'}).click();
  await expect(form).toHaveCount(0);
  const write = fixture.writes.find(w=>w.path.endsWith('/manual-claims'))!;
  expect(write.body).toMatchObject({statement:'发送三套候选房源',type:'next_action',owner:'Kyle',due_at:'2026-10-01'});
  expect((write.body as {segment_ids:string[]}).segment_ids.length).toBeGreaterThan(0);
  await expect(page.locator('.rail-action-list')).toContainText('Kyle');
  await expect(page.locator('.rail-action-list')).toContainText('2026/10/01');
});


test('long audio reader scrolls back to the top and keeps its dock inside resized windows', async ({page}) => {
  const fixture = new NotiqueApiFixture();
  fixture.enableSummaryFirstFlow(); fixture.completeSummary(); fixture.completeFacts();
  fixture.readerAudioMode = true;
  await fixture.install(page);
  // A real decodable local WAV exercises the player without remote media or AI calls.
  const wav = Buffer.alloc(44 + 8000 * 2 * 100);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await page.route('**/assets/audio-event-a/evidence-view', route => {
    const range = route.request().headers().range;
    const start = Number(range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
    return route.fulfill({status:range ? 206 : 200,contentType:'audio/wav',
      headers:{'Accept-Ranges':'bytes', ...(range ? {'Content-Range':`bytes ${start}-${wav.length - 1}/${wav.length}`} : {})},body:wav.subarray(start)});
  });
  await page.setViewportSize({width:1440,height:800});
  await page.goto('/?project=project-a&event=event-a&view=simple');
  const reader = page.locator('.reader-reading-scroll');
  const dock = page.locator('.reader-audio-player');
  await expect(dock).toBeVisible();
  await expect(page.locator('audio')).toHaveJSProperty('duration', 100);
  for (const size of [{width:1440,height:800}, {width:1100,height:620}, {width:1024,height:520}]) {
    await page.setViewportSize(size);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(size.height + 1);
    // Wheel outside the inner pane used to grow the reader and trap the header above the viewport.
    await page.mouse.move(size.width - 3, size.height / 2);
    await page.mouse.wheel(0, 700);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    await reader.hover();
    await page.mouse.wheel(0, 1200);
    await expect.poll(() => reader.evaluate(e => e.scrollTop)).toBeGreaterThan(500);
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => reader.evaluate(e => e.scrollTop)).toBe(0);
    const box = (await dock.boundingBox())!;
    const pane = (await page.locator('.reader-reading-pane').boundingBox())!;
    expect(box.y + box.height).toBeLessThan(size.height);
    expect(box.x).toBeGreaterThanOrEqual(pane.x);
    expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
  }
  await page.locator('.reader-chapters .chapter-time').last().click();
  await expect(page.locator('.transcript-turn.selected').first()).toBeInViewport();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.getByRole('slider', {name:'录音进度'}).fill('2');
  await expect(page.locator('audio')).toHaveJSProperty('currentTime', 2);
  await dock.locator('.audio-play-button').click();
  await expect(page.locator('audio')).toHaveJSProperty('paused', false);
  await reader.hover(); await page.mouse.wheel(0, -10000);
  await expect.poll(() => reader.evaluate(e => e.scrollTop)).toBe(0);
  await expect(page.getByRole('button', {name:'回到播放位置'})).toBeVisible();
  await page.getByRole('slider', {name:'录音进度'}).fill('72');
  await expect.poll(() => page.locator('audio').evaluate((e: HTMLAudioElement) => e.currentTime)).toBeGreaterThan(72.2);
  expect(await reader.evaluate(e => e.scrollTop)).toBe(0);
  await page.getByRole('button', {name:'回到播放位置'}).click();
  await expect.poll(() => reader.evaluate(e => e.scrollTop)).toBeGreaterThan(100);
  await dock.locator('.audio-play-button').click();
  // Crossing the compact layout breakpoint must not leave the dock overlapping the action sheet.
  await page.setViewportSize({width:900,height:620});
  await page.mouse.move(500,350); await page.mouse.wheel(0,1200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
  const compactDock = (await dock.boundingBox())!;
  const sheet = (await page.locator('.reader-action-rail').boundingBox())!;
  expect(compactDock.y + compactDock.height).toBeLessThanOrEqual(620);
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(compactDock.y);
  await page.setViewportSize({width:1440,height:800});
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(801);
  // 顶栏现在是面包屑，「当前项目」选择框已撤掉。这里量的还是同一件事：回到桌面宽度后
  // 整条顶栏仍在视口内，没有被阅读区顶出屏幕。认整条而不认里面某一件，宽度一变里面
  // 哪几件露出来会跟着变，整条不会。
  await expect(page.locator('.simple-session')).toBeInViewport();
});
