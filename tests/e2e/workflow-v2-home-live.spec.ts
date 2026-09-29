import {expect,test} from '@playwright/test';

test('home actions wait for interaction and the explanation preserves reading, partial acceptance and results',async({page},info)=>{
 let releaseScripts:()=>void=()=>undefined;
 const scripts=new Promise<void>(resolve=>{releaseScripts=resolve;});
 await page.route('**/*',async route=>{
  if(route.request().resourceType()==='script')await scripts;
  await route.continue();
 });
 try {
  await page.goto('/',{waitUntil:'commit'});
  const explain=page.getByRole('button',{name:'这东西怎么工作',exact:true});
  await expect(explain).toBeDisabled();await expect(page.getByRole('button',{name:/^上传音频 /})).toBeDisabled();
  releaseScripts();await expect(explain).toBeEnabled();await explain.click();
  await expect(page.getByRole('heading',{name:'使用说明',exact:true})).toBeVisible();
  await expect(page.getByText('确认过的才进报告',{exact:false})).toHaveCount(0);
  await expect(page.getByText(/只确认一部分也可以先离开/)).toBeVisible();
  await expect(page.getByText(/行动完成和问题得到答案分别记录/)).toBeVisible();
  await page.getByRole('heading',{name:'按需确认和跟进',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('how-it-works-product-loop.png'),fullPage:false});
  await page.getByRole('button',{name:'返回首页',exact:true}).click();
  await expect(page.getByText('先读完整记录，按需确认重点，再跟进和补结果',{exact:true})).toBeVisible();
 }finally{releaseScripts();}
});
