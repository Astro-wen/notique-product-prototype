import {test,expect,type APIRequestContext} from '@playwright/test';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createLocalWorkflowFixture} from '../helpers/local-workflow-fixture.mjs';
import {localMcpFixture} from '../helpers/local-mcp-fixture.mjs';

async function workspaceId(request:APIRequestContext){
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const current=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  return current.data.access.workspaceId as string;
}

test('anonymous connection page explains login and does not claim an installed assistant',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/connections');
  await expect(page.getByRole('heading',{name:'连接 Notique 到 AI 助手'})).toBeVisible();
  await expect(page.getByRole('button',{name:'登录后授权',exact:true})).toBeDisabled();
  await expect(page.getByText('连接是否启用请查看 AI 助手的插件页。',{exact:false})).toBeVisible();
  await page.screenshot({path:info.outputPath('mcp-anonymous.png'),fullPage:true});
  expect(errors).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('actual page grants readonly access, official client reads and revocation immediately stops it',async({page,request,baseURL},info)=>{
  const ws=await workspaceId(request),f=await createLocalWorkflowFixture(ws),identity=localMcpFixture(ws);
  let client:Client|undefined;
  try{
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.setExtraHTTPHeaders(identity.headers);
    await page.goto('/connections');await expect(page.getByRole('button',{name:'开启只读授权',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'开启只读授权',exact:true}).click();await expect(page.getByRole('button',{name:'断开授权',exact:true})).toBeVisible();
    await expect(page.getByText('已授权',{exact:true})).toBeVisible();await expect(page.getByText(identity.email,{exact:true})).toBeVisible();
    await page.getByText('通过连接地址接入',{exact:true}).click();await expect(page.getByRole('button',{name:'复制连接地址',exact:true})).toBeEnabled();
    await page.screenshot({path:info.outputPath('mcp-authorized.png'),fullPage:true});
    client=new Client({name:'pc-integration-client',version:'1.0'});
    const transport=new StreamableHTTPClientTransport(new URL('/mcp',baseURL!),{requestInit:{headers:identity.headers}});
    await client.connect(transport);const tools=await client.listTools();expect(tools.tools).toHaveLength(6);
    const before=f.analysisEvidence();
    const record=await client.callTool({name:'get_record_views',arguments:{record_id:f.eventId}});expect(record.isError).toBeUndefined();expect((record.structuredContent as {kind?:string})?.kind).toBe('record_views');
    const excerpt=await client.callTool({name:'get_record_excerpt',arguments:{record_id:f.eventId}});expect(excerpt.isError).toBeUndefined();expect((excerpt.structuredContent as {kind?:string})?.kind).toBe('original_excerpt');
    expect(f.analysisEvidence()).toEqual(before);
    await page.getByRole('button',{name:'断开授权',exact:true}).click();await expect(page.getByRole('button',{name:'开启只读授权',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'复制连接地址',exact:true})).toBeDisabled();
    await expect(client.callTool({name:'list_records',arguments:{project_id:f.projectId}})).rejects.toThrow();
    await page.screenshot({path:info.outputPath('mcp-revoked.png'),fullPage:true});
    expect(errors).toEqual([]);
  }finally{await client?.close();await page.close();await identity.cleanup();f.cleanup();}
});

test('permission loss and a lost save response clear stale connection state and can be recovered',async({page,request},info)=>{
  const identity=localMcpFixture(await workspaceId(request));
  try{
    await page.setExtraHTTPHeaders(identity.headers);await page.goto('/connections');await expect(page.getByRole('button',{name:'开启只读授权',exact:true})).toBeVisible();
    await page.route('**/api/v2/mcp-connection',async route=>{
      if(route.request().method()==='POST'){await route.fetch();await route.abort('failed');}else await route.continue();
    });
    await page.getByRole('button',{name:'开启只读授权',exact:true}).click();await expect(page.getByRole('alert')).toContainText('授权状态暂时无法确认，请重新读取。');await expect(page.getByRole('button',{name:'断开授权',exact:true})).toHaveCount(0);
    await page.unroute('**/api/v2/mcp-connection');await page.getByRole('button',{name:'重新读取状态',exact:true}).click();await expect(page.getByRole('button',{name:'断开授权',exact:true})).toBeVisible();
    identity.revokeMembership();await page.getByRole('button',{name:'重新读取状态',exact:true}).click();await expect(page.getByRole('button',{name:'开启只读授权',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'开启只读授权',exact:true}).click();await expect(page.getByRole('alert')).toContainText('工作空间权限已变化');
    await page.screenshot({path:info.outputPath('mcp-access-lost.png'),fullPage:true});
  }finally{await page.close();await identity.cleanup();}
});

test('connection settings respect unsaved input in the main workspace',async({page,request})=>{
  const f=await createLocalWorkflowFixture(await workspaceId(request));
  try{
    await page.goto(`/?project=${f.projectId}&event=${f.eventId}&view=simple`);
    await page.getByTestId(`bullet-${f.budgetId}`).getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByRole('textbox',{name:'修改重点',exact:true}).fill('尚未保存的新问题');
    await page.getByRole('button',{name:'AI助手连接',exact:true}).click();
    await expect(page.getByRole('textbox',{name:'修改重点',exact:true})).toHaveValue('尚未保存的新问题');
    expect(new URL(page.url()).pathname).toBe('/');
    await page.getByRole('button',{name:'取消',exact:true}).click();
    await page.getByRole('button',{name:'AI助手连接',exact:true}).click();
    await expect(page.getByRole('heading',{name:'连接 Notique 到 AI 助手'})).toBeVisible();
    await page.getByRole('link',{name:'返回工作区',exact:true}).click();
    await expect(page.getByTestId(`bullet-${f.budgetId}`)).toBeVisible();
    expect(new URL(page.url()).searchParams.get('event')).toBe(f.eventId);
    expect(new URL(page.url()).searchParams.get('project')).toBe(f.projectId);
  }finally{await page.close({runBeforeUnload:false});f.cleanup();}
});
