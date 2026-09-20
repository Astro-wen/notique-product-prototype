import { expect, test, type Page } from '@playwright/test';
import { NotiqueApiFixture } from './notique-api-fixture';

async function setup(page: Page, blocked = false) {
 const fixture=new NotiqueApiFixture();await fixture.install(page);
 const projects=[
  {id:'project-a',name:'客户 A',folder_name:'买方客户',created_at:'2026-09-01T00:00:00Z',updated_at:'2026-09-03T00:00:00Z',last_opened_at:'2026-09-02T00:00:00Z',event_count:1},
  {id:'project-b',name:'客户 B',folder_name:null,created_at:'2026-09-02T00:00:00Z',updated_at:'2026-09-01T00:00:00Z',last_opened_at:null,event_count:2},
 ];
 const writes:{method:string;path:string;body:Record<string,unknown>}[]=[];
 await page.route('**/api/v1/projects**',async route=>{
  const request=route.request(), path=new URL(request.url()).pathname,method=request.method();
  const response=(data:unknown,status=200)=>route.fulfill({status,json:{data,request_id:'project-index-test'}});
  if(path==='/api/v1/projects'&&method==='GET')return response({projects});
  const preview=path.match(/\/projects\/([^/]+)\/delete-preview$/);
  if(preview){const p=projects.find(p=>p.id===preview[1])!;return response({preview:{project_id:p.id,project_name:p.name,can_delete:!(blocked&&p.id==='project-b'),active_job_count:blocked&&p.id==='project-b'?1:0,event_count:p.event_count,material_count:2,pending_count:0}});}
  const match=path.match(/\/projects\/([^/]+)$/);
  if(match&&(method==='PUT'||method==='DELETE')){
   const index=projects.findIndex(p=>p.id===match[1]); const body=request.postDataJSON();writes.push({method,path,body});
   if(method==='PUT'){Object.assign(projects[index],{name:body.name,folder_name:body.folder_name,updated_at:'2026-09-05T00:00:00Z'});return response({project:projects[index]});}
   return response({project:projects.splice(index,1)[0]});
  }
  return route.fallback();
 });
 await page.goto('/?view=projects');await expect(page.locator('.pi-item')).toHaveCount(2);return {writes,projects};
}

test('view and sort match menu; preferences survive reload; folder tags filter projects',async({page})=>{
 await setup(page);
 await expect(page.locator('.pi-title').first()).toHaveText('客户 B');
 await page.getByRole('button',{name:'视图',exact:true}).click();await page.getByRole('menuitemradio',{name:'列表视图'}).click();
 await expect(page.locator('.pi-list')).toBeVisible();
 await page.getByRole('button',{name:'排序',exact:true}).click();await expect(page.getByRole('menuitemradio')).toHaveText(['创建时间','打开时间','修改时间','名称','降序','升序']);
 await page.getByRole('menuitemradio',{name:'打开时间'}).click();await expect(page.locator('.pi-title').first()).toHaveText('客户 A');
 await page.reload();await expect(page.locator('.pi-list')).toBeVisible();await expect(page.locator('.pi-title').first()).toHaveText('客户 A');
 await page.getByRole('button',{name:'买方客户',exact:true}).click();await expect(page.locator('.pi-item')).toHaveCount(1);
});

test('click title renames without opening; folder metadata is saved',async({page})=>{
 const {writes}=await setup(page);await page.locator('.pi-title').filter({hasText:'客户 A'}).click();
 await page.getByLabel('项目名称',{exact:true}).fill('新客户名称');await page.getByRole('button',{name:'保存',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.pi-title').filter({hasText:'新客户名称'})).toBeVisible();expect(writes[0].method).toBe('PUT');
 await page.getByRole('button',{name:'新客户名称的操作'}).click();await page.getByRole('menuitem',{name:'关联文件夹'}).click();
 await page.getByRole('dialog').getByLabel('文件夹',{exact:true}).fill('待跟进');await page.getByRole('button',{name:'保存',exact:true}).click();
 await expect(page.getByRole('button',{name:'待跟进',exact:true})).toBeVisible();expect(writes[1].body.folder_name).toBe('待跟进');
});

test('batch selects all, offers only export/delete; cancel causes no deletion; blocked projects stay',async({page})=>{
 const {writes}=await setup(page,true);await page.getByRole('button',{name:'批量',exact:true}).click();await page.getByLabel('全选').check();
 await expect(page.locator('.pi-tools button')).toHaveText(['导出','删除','取消批量']);
 await page.getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();expect(writes).toEqual([]);
 await page.getByRole('button',{name:'删除',exact:true}).click();await expect(page.getByText('转写或分析任务尚未完成，暂时不能删除')).toBeVisible();
 await page.getByRole('button',{name:'移到回收站'}).click();await expect(page.getByRole('alert')).toContainText('客户 B');
 expect(writes.filter(w=>w.method==='DELETE').map(w=>w.path)).toEqual(['/api/v1/projects/project-a']);await expect(page.locator('.pi-item')).toHaveCount(1);
});

test('batch export produces a downloaded zip and honors raw metadata options',async({page})=>{
 await setup(page);
 await page.route('**/api/v1/projects/*/events',route=>route.fulfill({json:{data:{events:[{id:'event-a',project_id:'project-a',title:'第一次沟通',event_type:'meeting'}]}}}));
 await page.route('**/api/v1/events/*/transcript-segments',route=>route.fulfill({json:{data:{segments:[{id:'s1',event_id:'event-a',asset_version_id:'v1',ordinal:0,speaker:'买家',start_ms:1000,end_ms:2000,text:'实际原文'}]}}}));
 await page.getByRole('button',{name:'批量',exact:true}).click();await page.getByLabel('全选').check();await page.getByRole('button',{name:'导出',exact:true}).click();
 const format=page.getByRole('combobox',{name:'文件格式'});
 await expect(format).toHaveText('纯文本 · .txt');
 const anchor=await format.boundingBox();
 await format.click();
 const menu=page.getByRole('listbox');await expect(menu).toBeVisible();
 const popup=await menu.boundingBox();
 expect(Math.abs(popup!.x-anchor!.x)).toBeLessThan(2);
 expect(Math.abs(popup!.width-anchor!.width)).toBeLessThan(2);
 expect(Math.abs(popup!.y-anchor!.y-anchor!.height)).toBeLessThan(12);
 await page.getByRole('option',{name:'Word 文档 · .docx'}).click();
 await expect(format).toHaveText('Word 文档 · .docx');
 await format.focus();await page.keyboard.press('Enter');await expect(page.getByRole('option',{name:'Word 文档 · .docx'})).toBeFocused();await page.keyboard.press('Home');await expect(page.getByRole('option',{name:'纯文本 · .txt'})).toBeFocused();await page.keyboard.press('Enter');
 await expect(format).toHaveText('纯文本 · .txt');
 await page.getByLabel('发言人',{exact:true}).uncheck();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出到本地'}).click();expect((await download).suggestedFilename()).toBe('Notique-2个项目.zip');await expect(page.getByRole('status')).toContainText('已导出 2 份文档');
});

for(const width of [1024,1440,1920]) test(`project index fits desktop at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});await setup(page);await page.getByRole('button',{name:'视图',exact:true}).click();await page.getByRole('menuitemradio',{name:'列表视图'}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
});
