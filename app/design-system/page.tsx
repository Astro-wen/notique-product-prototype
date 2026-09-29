"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, AudioLines, Check, FileText, Image, Mic, Plus } from "lucide-react";
import { Tabs } from "radix-ui";
import { Modal } from "../components/modal";
import { NqActionCard, NqButton, NqStatus, NqSurface } from "../components/notique-ui";

const nqPalette = [
  ["文字 / 主操作", "--ink", "#0d0d0d"], ["辅助文字", "--muted", "#59657b"],
  ["品牌蓝", "--blue", "#4b75f2"], ["页面底色", "--canvas", "#f9fafb"],
  ["分隔线", "--line", "#e6e6e8"], ["提示红", "--red", "#cb3f58"],
];

export default function NotiqueDesignSystemPage() {
  const [nqDialogOpen, setNqDialogOpen] = useState(false);
  const [nqFeedback, setNqFeedback] = useState("选择组件，查看交互效果。");
  const [nqDemoName, setNqDemoName] = useState("首次看房沟通");
  const [nqAccepted, setNqAccepted] = useState(false);
  return <main className="design-system-page">
    <header className="ds-header"><Link className="ds-brand" href="/">notique / 视觉与组件</Link><Link href="/?view=simple"><ArrowLeft size={14} aria-hidden="true" /> 返回工作空间</Link></header>
    <div className="ds-intro"><span className="ds-eyebrow">Notique · design reference · 01</span><h1>让每一次记录，清晰一致。</h1><p>以 Notique 官网的公开样式为基础，整理颜色、文字和常用组件。这里的示例可交互，不会录音、上传或修改项目。</p></div>
    <nav className="ds-nav" aria-label="组件目录"><a href="#foundations">基础样式</a><a href="#controls">操作与反馈</a><a href="#patterns">记录组件</a><a href="#reuse">复用说明</a></nav>

    <section className="ds-section" id="foundations"><h2>01 / 基础样式</h2><p>白色内容面板、克制的黑色主操作，以及用于选中和链接的蓝色。</p>
      <div className="ds-swatches">{nqPalette.map(([name, token, color]) => <div className="ds-swatch" key={token}><div className="ds-swatch-color" style={{ background: color }} /><div className="ds-swatch-copy"><strong>{name}</strong><code>{color}</code><code>{token}</code></div></div>)}</div>
      <div className="ds-grid"><NqSurface><h3 className="ds-demo-title">文字层级</h3><div className="ds-type-sample"><p className="ds-type-heading">一段对话，一份清晰的记录</p><p className="ds-type-body">从原文出发，整理重要信息，随时回到出处。</p><p className="ds-type-label">正文 16 / 标签 14 / 辅助信息 12</p><p className="ds-type-meta">Noto Sans TC · PingFang · 系统字体</p></div></NqSurface>
      <NqSurface><h3 className="ds-demo-title">留白与轮廓</h3><div className="ds-stack"><p className="ds-type-body">按钮圆角 6px，内容卡片 10px，弹窗 8px。边框区分内容，阴影用于浮层。</p><div className="ds-row"><NqStatus>品牌蓝用于导航</NqStatus><NqStatus tone="success">绿色表示完成</NqStatus></div><p className="ds-caption">小字号蓝色按钮使用更深的蓝色；辅助文字避免过浅，便于阅读。</p></div></NqSurface></div>
    </section>

    <section className="ds-section" id="controls"><h2>02 / 操作与反馈</h2><p>每个区域保留一个明确的主操作，次要操作降低视觉权重。</p><div className="ds-grid">
      <NqSurface><h3 className="ds-demo-title">按钮</h3><div className="ds-row"><NqButton onClick={()=>setNqFeedback("已点击主操作，示例不写入项目。")}><Plus size={16} />新建记录</NqButton><NqButton variant="secondary" onClick={()=>setNqFeedback("已点击次要操作。")}>查看原文</NqButton><NqButton variant="accent" id="nq-dialog-trigger" onClick={()=>setNqDialogOpen(true)}>打开弹窗</NqButton><NqButton variant="quiet" onClick={()=>setNqFeedback("已取消示例操作。")}>取消</NqButton></div><div className="ds-row"><NqButton disabled>暂不可用</NqButton><NqButton loading>处理中</NqButton></div><p className="ds-feedback" role="status">{nqFeedback}</p></NqSurface>
      <NqSurface><h3 className="ds-demo-title">字段与状态</h3><label className="ds-field">记录名称<input value={nqDemoName} onChange={e=>setNqDemoName(e.target.value)} placeholder="输入记录名称" maxLength={80} /></label><div className="ds-row"><NqStatus>已整理</NqStatus><NqStatus tone="pending">待确认</NqStatus><NqStatus tone="success">已完成</NqStatus><NqStatus tone="error">上传失败</NqStatus></div><p className="ds-caption">状态同时使用文字和颜色表达；示例名称会同步到下方卡片。</p></NqSurface>
    </div></section>

    <section className="ds-section" id="patterns"><h2>03 / 记录组件</h2><p>复用工作空间中的上传入口与弹窗，业务能力继续使用现有流程。</p><div className="ds-grid">
      <NqSurface><h3 className="ds-demo-title">开始一份记录</h3><div className="ds-demo-actions"><NqActionCard icon={Mic} kind="record" title="开始录音" description="记录当下的对话" onClick={()=>setNqFeedback("录音入口示例：没有启动麦克风。")}/><NqActionCard icon={AudioLines} kind="audio" title="上传音频" description="导入已有录音" onClick={()=>setNqFeedback("音频入口示例：没有上传文件。")}/><NqActionCard icon={FileText} kind="text" title="粘贴文字" description="整理已有逐字稿" onClick={()=>setNqFeedback("文字入口示例：没有写入项目。")}/><NqActionCard icon={Image} kind="photo" title="上传图片" description="保留现场的材料" onClick={()=>setNqFeedback("图片入口示例：没有上传文件。")}/></div></NqSurface>
      <NqSurface><Tabs.Root defaultValue="source"><Tabs.List className="ds-tabs" aria-label="记录示例"><Tabs.Trigger value="source">原文出处</Tabs.Trigger><Tabs.Trigger value="action">下一步</Tabs.Trigger></Tabs.List><Tabs.Content value="source" className="ds-record"><NqStatus>示例记录</NqStatus><h3>{nqDemoName || "未命名记录"}</h3><blockquote>“希望周末安排一次看房，先了解交通和周边环境。”</blockquote><p className="ds-caption">00:42 · 示例说话人 · 合成内容</p><p className="ds-type-label">结果与出处放在一起，需要时再展开细节。</p></Tabs.Content><Tabs.Content value="action" className="ds-record"><NqStatus tone={nqAccepted ? "success" : "pending"}>{nqAccepted ? "已采纳" : "行动建议"}</NqStatus><h3>确认周末可预约的看房时段</h3><p className="ds-type-label">来自上方示例对话。这是组件演示，不会新增真实待办。</p><NqButton variant={nqAccepted ? "secondary" : "primary"} onClick={()=>setNqAccepted(!nqAccepted)}>{nqAccepted && <Check size={16} />}{nqAccepted ? "撤销示例采纳" : "采纳示例建议"}</NqButton></Tabs.Content></Tabs.Root></NqSurface>
    </div></section>

    <section className="ds-section" id="reuse"><h2>04 / 复用说明</h2><p>参考官网实际发布的 CSS 和 JavaScript；将样式约定移植到本项目已有的 React / Radix 组件中。</p><NqSurface><div className="ds-table-wrap"><table className="ds-table"><thead><tr><th>组件</th><th>使用约定</th><th>当前应用</th></tr></thead><tbody><tr><td><code>NqButton</code></td><td>主、次、轻量、强调、危险操作及加载态</td><td>本视觉库</td></tr><tr><td><code>NqActionCard</code></td><td>图标、标题、说明与禁用状态</td><td>工作空间上传入口</td></tr><tr><td><code>NqIconButton</code></td><td>必须提供可读的操作名称</td><td>工作空间弹窗关闭按钮</td></tr><tr><td><code>NqSurface / NqStatus</code></td><td>内容容器与带文字的状态</td><td>本视觉库，可逐步复用</td></tr></tbody></table></div><p className="ds-caption">参考范围：2026-09-28 的公开资源和登录页；登录后的完整页面尚未核对。颜色和组件样式有来源，具体业务布局是当前项目的适配。</p><div className="ds-row"><a href="https://app.notiqueai.com/" target="_blank" rel="noreferrer">查看 Notique 官网</a><a href="/design-system/tokens.json" download>下载设计变量</a></div></NqSurface></section>
    {nqDialogOpen && <Modal title="编辑记录名称" description="此弹窗只修改本页示例，关闭后返回组件库。" onClose={()=>setNqDialogOpen(false)} returnFocusSelector="#nq-dialog-trigger"><div className="pi-dialog-body"><label className="ds-field">记录名称<input value={nqDemoName} maxLength={80} onChange={e=>setNqDemoName(e.target.value)} /></label><div className="modal-actions"><NqButton variant="secondary" onClick={()=>setNqDialogOpen(false)}>关闭</NqButton><NqButton onClick={()=>{setNqDialogOpen(false);setNqFeedback("示例名称已更新，没有修改真实项目。");}}>完成</NqButton></div></div></Modal>}
  </main>;
}
