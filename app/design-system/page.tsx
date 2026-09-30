"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, AudioLines, Check, FileText, Image, Mic, Plus } from "lucide-react";
import { Tabs } from "radix-ui";
import { Modal } from "../components/modal";
import { NqActionCard, NqButton, NqProjectCard, NqStatus, NqSurface } from "../components/notique-ui";

const nqPalette = [
  ["文字 / 主操作", "--ink", "#0d0d0d"], ["辅助文字", "--muted", "#59657b"],
  ["品牌蓝", "--blue", "#4b75f2"], ["页面底色", "--canvas", "#f5f6f8"],
  ["分隔线", "--line", "#e6e6e8"], ["提示红", "--red", "#cb3f58"],
];

export default function NotiqueDesignSystemPage() {
  const [nqDialogOpen, setNqDialogOpen] = useState(false);
  const [nqDialogReturn, setNqDialogReturn] = useState("#nq-dialog-trigger");
  const [nqFeedback, setNqFeedback] = useState("选择组件，查看交互效果。");
  const [nqDemoName, setNqDemoName] = useState("首次看房沟通");
  const [nqAccepted, setNqAccepted] = useState(false);
  return <main className="design-system-page">
    <header className="ds-header"><Link className="ds-brand" href="/">notique / 视觉与组件</Link><Link href="/?view=simple"><ArrowLeft size={14} aria-hidden="true" /> 返回工作空间</Link></header>
    <div className="ds-intro"><span className="ds-eyebrow">Notique · design reference · 02</span><h1>让每一次记录，清晰一致。</h1><p>依据已登录 Notique 的项目、时间线和原文页面，复用实际字体、颜色、尺寸和组件状态。这里展示工作空间正在使用的共用组件。</p></div>
    <nav className="ds-nav" aria-label="组件目录"><a href="#foundations">基础样式</a><a href="#controls">操作与反馈</a><a href="#patterns">记录组件</a><a href="#reuse">复用说明</a></nav>

    <section className="ds-section" id="foundations"><h2>01 / 基础样式</h2><p>白色内容面板、克制的黑色主操作，以及用于选中和链接的蓝色。</p>
      <div className="ds-swatches">{nqPalette.map(([name, token, color]) => <div className="ds-swatch" key={token}><div className="ds-swatch-color" style={{ background: color }} /><div className="ds-swatch-copy"><strong>{name}</strong><code>{color}</code><code>{token}</code></div></div>)}</div>
      <div className="ds-grid"><NqSurface><h3 className="ds-demo-title">文字层级</h3><div className="ds-type-sample"><p className="ds-type-heading">一段对话，一份清晰的记录</p><p className="ds-type-body">从原文出发，整理重要信息，随时回到出处。</p><p className="ds-type-label">正文 16 / 标签 14 / 辅助信息 12</p><p className="ds-type-meta">Noto Sans TC · PingFang TC · Roboto · 系统字体</p></div></NqSurface>
      <NqSurface><h3 className="ds-demo-title">留白与轮廓</h3><div className="ds-stack"><p className="ds-type-body">项目卡高89px、圆角16px、边框2px。按钮圆角6px，原文块圆角8px。边框区分内容，阴影用于浮层。</p><div className="ds-row"><NqStatus>品牌蓝用于导航</NqStatus><NqStatus tone="success">绿色表示完成</NqStatus></div><p className="ds-caption">小字号深蓝、状态色与键盘焦点是本项目的可读性适配。</p></div></NqSurface></div>
    </section>

    <section className="ds-section" id="controls"><h2>02 / 操作与反馈</h2><p>每个区域保留一个明确的主操作，次要操作降低视觉权重。</p><div className="ds-grid">
      <NqSurface><h3 className="ds-demo-title">按钮</h3><div className="ds-row"><NqButton onClick={()=>setNqFeedback("已点击主操作，示例不写入项目。")}><Plus size={16} />新建记录</NqButton><NqButton variant="secondary" onClick={()=>setNqFeedback("已点击次要操作。")}>查看原文</NqButton><NqButton variant="accent" id="nq-dialog-trigger" onClick={()=>{setNqDialogReturn("#nq-dialog-trigger");setNqDialogOpen(true);}}>打开弹窗</NqButton><NqButton variant="quiet" onClick={()=>setNqFeedback("已取消示例操作。")}>取消</NqButton></div><div className="ds-row"><NqButton disabled>暂不可用</NqButton><NqButton loading>处理中</NqButton></div><p className="ds-feedback" role="status">{nqFeedback}</p></NqSurface>
      <NqSurface><h3 className="ds-demo-title">字段与状态</h3><label className="ds-field">记录名称<input value={nqDemoName} onChange={e=>setNqDemoName(e.target.value)} placeholder="输入记录名称" maxLength={80} /></label><div className="ds-row"><NqStatus>已整理</NqStatus><NqStatus tone="pending">待确认</NqStatus><NqStatus tone="success">已完成</NqStatus><NqStatus tone="error">上传失败</NqStatus></div><p className="ds-caption">状态同时使用文字和颜色表达；示例名称会同步到下方卡片。</p></NqSurface>
    </div></section>

    <section className="ds-section" id="patterns"><h2>03 / 记录组件</h2><p>项目卡与工作空间复用同一个组件，原文采用官网16px/26px字号和行高。</p><div className="ds-grid"><NqSurface><h3 className="ds-demo-title">项目卡</h3><div className="pi-grid"><NqProjectCard title={nqDemoName || "首次沟通"} onOpen={()=>setNqFeedback("已打开示例项目。")} folder={<span className="pi-folder-tag">默认文件夹</span>} records="3 条记录" modified="9月30日" controls={<NqButton id="nq-project-demo-menu" variant="quiet" onClick={()=>{setNqDialogReturn("#nq-project-demo-menu");setNqDialogOpen(true);}} aria-label="修改示例项目名称">更多</NqButton>}/></div><p className="ds-caption">点击名称打开项目，重命名由更多操作进入。悬停与选中沿用官网浅蓝背景和蓝色边框。</p></NqSurface><NqSurface><h3 className="ds-demo-title">原文块</h3><div className="interface-refresh readable-artifact"><article><button className="transcript-copy-button" onClick={()=>setNqFeedback("已定位示例原文。")}><span>培训与场地安排放在各自主题里。讲师报价、教材和预算审批继续归在同一次培训。</span></button></article></div><p className="ds-caption">留白12px 16px、圆角8px、正文16px/26px，点击与焦点使用品牌蓝。</p></NqSurface>
      <NqSurface><h3 className="ds-demo-title">开始一份记录</h3><div className="ds-demo-actions"><NqActionCard icon={Mic} kind="record" title="开始录音" description="记录当下的对话" onClick={()=>setNqFeedback("录音入口示例：没有启动麦克风。")}/><NqActionCard icon={AudioLines} kind="audio" title="上传音频" description="导入已有录音" onClick={()=>setNqFeedback("音频入口示例：没有上传文件。")}/><NqActionCard icon={FileText} kind="text" title="粘贴文字" description="整理已有逐字稿" onClick={()=>setNqFeedback("文字入口示例：没有写入项目。")}/><NqActionCard icon={Image} kind="photo" title="上传图片" description="保留现场的材料" onClick={()=>setNqFeedback("图片入口示例：没有上传文件。")}/></div></NqSurface>
      <NqSurface><Tabs.Root defaultValue="source"><Tabs.List className="ds-tabs" aria-label="记录示例"><Tabs.Trigger value="source">原文出处</Tabs.Trigger><Tabs.Trigger value="action">下一步</Tabs.Trigger></Tabs.List><Tabs.Content value="source" className="ds-record"><NqStatus>示例记录</NqStatus><h3>{nqDemoName || "未命名记录"}</h3><blockquote>“希望周末安排一次看房，先了解交通和周边环境。”</blockquote><p className="ds-caption">00:42 · 示例说话人 · 合成内容</p><p className="ds-type-label">结果与出处放在一起，需要时再展开细节。</p></Tabs.Content><Tabs.Content value="action" className="ds-record"><NqStatus tone={nqAccepted ? "success" : "pending"}>{nqAccepted ? "已采纳" : "行动建议"}</NqStatus><h3>确认周末可预约的看房时段</h3><p className="ds-type-label">来自上方示例对话。这是组件演示，不会新增真实待办。</p><NqButton variant={nqAccepted ? "secondary" : "primary"} onClick={()=>setNqAccepted(!nqAccepted)}>{nqAccepted && <Check size={16} />}{nqAccepted ? "撤销示例采纳" : "采纳示例建议"}</NqButton></Tabs.Content></Tabs.Root></NqSurface>
    </div></section>

    <section className="ds-section" id="reuse"><h2>04 / 复用说明</h2><p>参考官网实际发布的 CSS 和 JavaScript；将样式约定移植到本项目已有的 React / Radix 组件中。</p><NqSurface><div className="ds-table-wrap"><table className="ds-table"><thead><tr><th>组件</th><th>使用约定</th><th>当前应用</th></tr></thead><tbody><tr><td><code>NqButton</code></td><td>主、次、轻量、强调、危险操作及加载态</td><td>记录批阅与本视觉库</td></tr><tr><td><code>NqProjectCard</code></td><td>89px项目卡、悬停、选中与菜单</td><td>项目管理与本视觉库</td></tr><tr><td><code>NqActionCard</code></td><td>图标、标题、说明与禁用状态</td><td>工作空间上传入口</td></tr><tr><td><code>NqIconButton</code></td><td>必须提供可读的操作名称</td><td>工作空间弹窗关闭按钮</td></tr><tr><td><code>NqSurface / NqStatus</code></td><td>内容容器与带文字的状态</td><td>本视觉库，可逐步复用</td></tr></tbody></table></div><p className="ds-caption">参考范围：2026-09-30 已登录的项目、时间线和原文页面。实际 DOM、计算样式与31份 CSS 已记录。官网参考值与本项目适配值在设计变量中分别保存。</p><div className="ds-row"><a href="https://app.notiqueai.com/" target="_blank" rel="noreferrer">查看 Notique 官网</a><a href="/design-system/tokens.json" download>下载设计变量</a></div></NqSurface></section>
    {nqDialogOpen && <Modal title="编辑记录名称" description="此弹窗只修改本页示例，关闭后返回组件库。" onClose={()=>setNqDialogOpen(false)} returnFocusSelector={nqDialogReturn}><div className="pi-dialog-body"><label className="ds-field">记录名称<input value={nqDemoName} maxLength={80} onChange={e=>setNqDemoName(e.target.value)} /></label><div className="modal-actions"><NqButton variant="secondary" onClick={()=>setNqDialogOpen(false)}>关闭</NqButton><NqButton onClick={()=>{setNqDialogOpen(false);setNqFeedback("示例名称已更新，没有修改真实项目。");}}>完成</NqButton></div></div></Modal>}
  </main>;
}
