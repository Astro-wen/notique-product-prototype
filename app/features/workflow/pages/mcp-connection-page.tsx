"use client";

import {useCallback, useEffect, useRef, useState} from 'react';
import Link from 'next/link';
import {ArrowLeft, Copy, Link2, NotebookPen} from 'lucide-react';
import {NqButton, NqStatus, NqSurface} from '@/app/components/notique-ui';
import {parseMcpConnectionStatus, type McpConnectionStatus} from '@/lib/shared/workflow-v2';
import base from '../components/record-workspace.module.css';
import styles from './mcp-connection.module.css';

class ConnectionSaveError extends Error {}

export function McpConnectionPage({loginHref, localPreview, returnHref}: {loginHref: string; localPreview: boolean; returnHref: string}) {
  const [status, setStatus] = useState<McpConnectionStatus | null>(null);
  const [issue, setIssue] = useState('');
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [endpoint, setEndpoint] = useState('/mcp');
  const sequence = useRef(0);
  const mounted = useRef(false);
  const savingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (savingRef.current) return;
    const current = ++sequence.current;
    setLoading(true);
    try {
      const response = await fetch('/api/v2/mcp-connection', {cache: 'no-store'});
      if (!response.ok) throw new Error('连接状态暂时无法读取，请重试。');
      const body = await response.json();
      const next = parseMcpConnectionStatus(body.data);
      if (mounted.current && current === sequence.current) {setStatus(next); setEndpoint(new URL('/mcp', window.location.origin).href); setIssue('');}
    } catch {
      if (mounted.current && current === sequence.current) {setStatus(null); setIssue('连接状态暂时无法读取，请重试。');}
    } finally {
      if (mounted.current && current === sequence.current) setLoading(false);
    }
  }, []);

  const closePage = useCallback(() => {mounted.current = false; sequence.current++;}, []);

  useEffect(() => {
    mounted.current = true;
    const initialRead = window.setTimeout(() => void refresh(), 0);
    const onFocus = () => {if (document.visibilityState === 'visible') void refresh();};
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const timer = window.setInterval(onFocus, 30_000);
    return () => {closePage(); window.clearTimeout(initialRead); window.clearInterval(timer); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus);};
  }, [refresh, closePage]);

  async function change(enabled: boolean) {
    savingRef.current = true;
    const current = ++sequence.current;
    setSaving(true); setLoading(false); setFeedback(''); setIssue('');
    try {
      const response = await fetch('/api/v2/mcp-connection', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({enabled})});
      const body = await response.json();
      if (!response.ok) throw new ConnectionSaveError(response.status === 401 ? '登录已过期，请重新登录。' : response.status === 403 ? '工作空间权限已变化，请联系空间管理员。' : '授权状态暂时无法确认，请重新读取。');
      const next = parseMcpConnectionStatus(body.data);
      if (mounted.current && current === sequence.current) {setStatus(next); setFeedback(enabled ? '只读授权已开启。接下来在AI助手中安装Notique连接。' : '授权已断开，新的读取会被拒绝。');}
    } catch (cause) {
      if (mounted.current && current === sequence.current) {setStatus(null); setIssue(cause instanceof ConnectionSaveError ? cause.message : '授权状态暂时无法确认，请重新读取。');}
    } finally {
      savingRef.current = false;
      if (mounted.current && current === sequence.current) setSaving(false);
    }
  }

  async function copyEndpoint() {
    try {await navigator.clipboard.writeText(new URL('/mcp', window.location.origin).href); setFeedback('连接地址已复制。');}
    catch {setFeedback('复制失败，请选中下面的连接地址复制。');}
  }

  const label = !status ? '正在读取' : !status.authenticated ? '登录后授权' : status.enabled ? '已授权' : '未授权';
  return <div className={`${base.workspace} ${styles.page}`}>
    <nav className={base.topbar} aria-label="连接页导航"><Link href={returnHref}><ArrowLeft size={16}/>返回工作区</Link><span className={styles.brand}><NotebookPen size={17}/> Notique AI</span></nav>
    <header className={base.header}><div><p className={base.eyebrow}>你的AI助手</p><h1>让AI助手读懂你的记录</h1><p className={base.subtitle}>把已有重点和原话交给自己的AI助手，继续整理、提问或写作。</p></div><Link2 size={28} aria-hidden="true"/></header>
    <NqSurface className={`${base.record} ${styles.authorization}`} aria-label="AI助手只读授权">
      <div className={styles.heading}><h2>1. 开启只读授权</h2><NqStatus tone={status?.enabled ? 'success' : 'info'}>{issue ? '状态待确认' : label}</NqStatus></div>
      <p>读取你有权访问的项目、沟通原文和已生成的结果。草稿与已采纳重点分别标明，采纳和改错仍在Notique中完成。</p>
      {status?.authenticated && <dl><div><dt>当前账号</dt><dd>{status.accountEmail}</dd></div><div><dt>授权有效期</dt><dd>{status.enabled && status.expiresAt ? new Date(status.expiresAt).toLocaleDateString('zh-CN') : '开启后30天'}</dd></div></dl>}
      {status && !status.authenticated && <p className={styles.help}>{localPreview ? '本地预览暂未登录。正式站支持登录并授权。' : '先登录当前账号，再选择是否授权。'}</p>}
      <div className={styles.buttons}>
        {status?.authenticated && <NqButton variant={status.enabled ? 'secondary' : 'primary'} loading={saving} disabled={loading} onClick={() => void change(!status.enabled)}>{status.enabled ? '断开授权' : '开启只读授权'}</NqButton>}
        {status && !status.authenticated && (localPreview ? <NqButton disabled>登录后授权</NqButton> : <a className="button primary" href={loginHref} target="_top">登录并继续</a>)}
        <NqButton variant="quiet" disabled={saving || loading} onClick={() => void refresh()}>{loading ? '正在读取状态…' : '重新读取状态'}</NqButton>
      </div>
      {issue && <p className={base.error} role="alert">{issue}</p>}
    </NqSurface>
    <NqSurface className={`${base.record} ${styles.connection}`} aria-label="AI助手连接方式">
      <h2>2. 在AI助手中安装Notique</h2>
      <p>在你的AI助手的插件或连接设置中安装Notique。ChatGPT或Codex中的站点创建者可从“Personal → Created by you”找到插件。完成连接后，可以试着问：</p>
      <blockquote>帮我看看最近的沟通记录，有哪些重点和需要跟进的事？</blockquote>
      <p className={styles.help}>这里显示的是Notique的读取授权。AI助手是否已安装连接，以它的插件页为准。AI助手的推理费用按其服务计费。</p>
      <details><summary>通过连接地址接入</summary><p className={styles.help}>适用于支持远程MCP及OAuth登录的客户端。</p><output className={styles.endpoint}>{endpoint}</output><NqButton variant="secondary" disabled={!status?.enabled || saving || loading} onClick={() => void copyEndpoint()}><Copy size={14}/>复制连接地址</NqButton></details>
    </NqSurface>
    <p className={base.feedback} role="status" aria-live="polite">{feedback}</p>
  </div>;
}
