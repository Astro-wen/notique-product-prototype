"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";

export function HowItWorks({ onBack }: { onBack: () => void }) {
  return <div className="page narrow-page hiw">
    <button className="text-button hiw-back" onClick={onBack}>
      <ArrowLeft size={15} aria-hidden="true" />返回首页
    </button>
    <header className="hiw-head">
      <h1>使用说明</h1>
      <p>先拿到能用的记录，再处理你在意的地方。</p>
    </header>
    <ol className="hiw-steps">
      <li>
        <h2>上传材料，先读重点</h2>
        <p>录音、逐字稿或笔记照片都可以。第一份材料会自动建好项目，整理后打开本次重点。读完即可复制记录。</p>
        <p className="hiw-example">例如：预算大约三十万，接下来向供应商询价。</p>
      </li>
      <li>
        <h2>按需确认和跟进</h2>
        <p>金额不对就点改一下，想核对就看原话。要继续做的事点加入跟进。只确认一部分也可以先离开，其余草稿保留。</p>
        <p className="hiw-example">普通重点可以直接确认，想继续的行动由你决定。</p>
      </li>
      <li>
        <h2>补上结果，下次接着用</h2>
        <p>有进展就补结果，问题也可以直接补答案。保存后回到同一份记录，整个项目汇总最新情况。下一次沟通点继续这件事。</p>
        <p className="hiw-example">例如：报价十二万，含安装。下次打开仍能看到这条答案。</p>
      </li>
    </ol>
    <section className="hiw-limits">
      <h2>两个标记，一个区别</h2>
      <ul>
        <li>AI 草稿是自动整理的内容，可以先读和复制。已采纳是你确认或修改过的内容。</li>
        <li>行动完成和问题得到答案分别记录。打勾表示事情做完，补答案表示问题有了结论。</li>
      </ul>
      <p>同一件事放在一个项目里，每次沟通是一条记录。</p>
    </section>
    <button className="button primary hiw-start" onClick={onBack}>开始添加材料<ArrowRight size={15} aria-hidden="true" /></button>
  </div>;
}
