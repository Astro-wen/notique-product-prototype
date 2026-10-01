"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";

export function HowItWorks({ onBack }: { onBack: () => void }) {
  return <div className="page narrow-page hiw">
    <button className="text-button hiw-back" onClick={onBack}>
      <ArrowLeft size={15} aria-hidden="true" />返回首页
    </button>
    <header className="hiw-head">
      <h1>使用说明</h1>
      <p>上传材料后查看原文和重点，需要时再确认、修改或跟进。</p>
    </header>
    <ol className="hiw-steps">
      <li>
        <h2>上传材料，先读重点</h2>
        <p>上传录音、逐字稿或笔记照片。首次上传会自动创建项目，处理完成后打开本次重点。记录可以直接复制。</p>
        <p className="hiw-example">例如：预算大约三十万，接下来向供应商询价。</p>
      </li>
      <li>
        <h2>按需确认和跟进</h2>
        <p>用“原话”查看出处，用“改一下”修正内容。需要执行的行动可点击“加入跟进”。未确认的内容会保留为草稿。</p>
        <p className="hiw-example">例如：修正预算金额，或将询价行动加入跟进。</p>
      </li>
      <li>
        <h2>记录跟进结果</h2>
        <p>点击“补结果”记录行动进展，点击“补答案”回答问题。保存后会更新记录和项目回顾。后续沟通可以添加到同一项目。</p>
        <p className="hiw-example">例如：在预算问题下补充“报价十二万，含安装”。</p>
      </li>
    </ol>
    <section className="hiw-limits">
      <h2>草稿、确认和完成状态</h2>
      <ul>
        <li>“AI 草稿”是自动整理、尚未确认的内容；“已采纳”表示你已确认或修改。两者都可以阅读和复制。</li>
        <li>行动完成和问题回答分别记录。完成行动后，相关问题仍可补充答案。</li>
      </ul>
      <p>一个项目可以包含多次沟通，每次沟通保存为一条记录。</p>
    </section>
    <button className="button primary hiw-start" onClick={onBack}>开始添加材料<ArrowRight size={15} aria-hidden="true" /></button>
  </div>;
}
