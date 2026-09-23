"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { DropdownMenu, Select } from 'radix-ui';
import { Check, ChevronDown, Download, FolderOpen, LayoutGrid, List, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api, toIssue, type ApiIssue, type Project, type ProjectDeletePreview } from '../api-client';
import { Modal } from './modal';
import { sortProjects, type ProjectSort } from '@/lib/domain/project-index';
import { documentBytes, transcriptParagraphs, zipFiles } from '@/lib/domain/project-export';
import type { EventSummaryOutput } from '@/lib/domain/event-ai-artifacts';

type Props = {
  state: string; issue: ApiIssue | null; projects: Project[];
  onRetry: () => void; onOpen: (id: string) => void; onCreate: () => void;
  onChanged: (project: Project) => void; onDeleted: (ids: string[]) => void; onTrash: () => void;
};
const sortLabels: Record<ProjectSort,string> = {createdAt:'创建时间',lastOpenedAt:'打开时间',updatedAt:'修改时间',name:'名称'};
const date = (value?: string) => {
  if (!value) return '尚未打开';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(parsed));
};
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\r\n]/g,' ').trim().slice(0,90) || '未命名';

export function ProjectIndex({state,issue,projects,onRetry,onOpen,onCreate,onChanged,onDeleted,onTrash}: Props) {
  const [view,setView] = useState<'grid'|'list'>('grid');
  const [sort,setSort] = useState<ProjectSort>('createdAt');
  const [direction,setDirection] = useState<'asc'|'desc'>('desc');
  const [query,setQuery] = useState('');
  const [folder,setFolder] = useState('*');
  const [bulk,setBulk] = useState(false);
  const [selected,setSelected] = useState<Set<string>>(new Set());
  const [edit,setEdit] = useState<{project:Project;name:string;folder:string;kind:'name'|'folder'} | null>(null);
  const [targets,setTargets] = useState<Project[]>([]);
  const [dialog,setDialog] = useState<'delete'|'export'|null>(null);
  const [previews,setPreviews] = useState<ProjectDeletePreview[]>([]);
  const [previewIssues,setPreviewIssues] = useState<Record<string,string>>({});
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('');
  const [error,setError] = useState('');
  const [raw,setRaw] = useState(true);
  const [summary,setSummary] = useState(false);
  const [format,setFormat] = useState<'docx'|'txt'>('txt');
  const [speakers,setSpeakers] = useState(true);
  const [timestamps,setTimestamps] = useState(true);
  const mutationKeys = useRef(new Map<string,string>());
  const allCheckbox = useRef<HTMLInputElement>(null);
  useEffect(()=>{
    const timer = window.setTimeout(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('notique.project-index') || '{}');
      if (saved.view === 'grid' || saved.view === 'list') setView(saved.view);
      if (Object.hasOwn(sortLabels,saved.sort)) setSort(saved.sort);
      if (saved.direction === 'asc' || saved.direction === 'desc') setDirection(saved.direction);
    } catch { /* A restricted browser may not expose local storage. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  },[]);
  function preference(next: Partial<{view: 'grid'|'list';sort: ProjectSort;direction:'asc'|'desc'}>) {
    const value={view,sort,direction,...next};setView(value.view);setSort(value.sort);setDirection(value.direction);
    try {localStorage.setItem('notique.project-index',JSON.stringify(value));} catch { /* Preferences are optional. */ }
  }
  const folders = [...new Set(projects.map(p=>p.folderName).filter((f): f is string=>Boolean(f)))].sort((a,b)=>a.localeCompare(b));
  const visible = useMemo(()=>sortProjects(projects.filter(p=>(folder==='*'||(p.folderName||'')===folder) && `${p.name} ${p.folderName||''}`.toLowerCase().includes(query.trim().toLowerCase())),sort,direction),[projects,folder,query,sort,direction]);
  const chosen = projects.filter(p=>selected.has(p.id));
  const allSelected = visible.length>0 && visible.every(p=>selected.has(p.id));
  useEffect(()=>{if(allCheckbox.current) allCheckbox.current.indeterminate=!allSelected && visible.some(p=>selected.has(p.id));},[visible,selected,allSelected]);
  function toggle(id:string) {setSelected(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});}
  function keyFor(value:string) {let key=mutationKeys.current.get(value);if(!key){key=crypto.randomUUID();mutationKeys.current.set(value,key);}return key;}
  function open(item:Project) {
    onOpen(item.id);
    void api.markProjectOpened(item.id).then(onChanged).catch(() => undefined);
  }
  async function saveEdit() {
    if(!edit?.name.trim()||busy)return;setBusy(true);setError('');
    try {
      const currentProject = edit.project.updatedAt ? edit.project : await api.getProject(edit.project.id);
      const updated=await api.updateProjectIndex(currentProject,edit.name.trim(),edit.folder.trim(),keyFor(`edit:${currentProject.id}:${currentProject.updatedAt}:${edit.name}:${edit.folder}`));
      onChanged(updated);setEdit(null);setMessage('已保存');
    } catch(e) {
      const issue = toIssue(e);
      if (issue.status === 409) {
        try {
          const latest = await api.getProject(edit.project.id);
          onChanged(latest);
          setEdit(current => current && current.project.id === latest.id ? {...current,project:latest} : current);
          setError('项目已被更新，已刷新最新版本，请再次保存。');
        } catch(refreshError) {
          setError(`项目已被更新，但刷新失败：${toIssue(refreshError).message}`);
        }
      } else setError(issue.message);
    } finally {setBusy(false);}
  }
  async function showDelete(items:Project[]) {
    setTargets(items);setDialog('delete');setError('');setPreviews([]);setPreviewIssues({});setBusy(true);
    const results = await Promise.allSettled(items.map(p=>api.getProjectDeletePreview(p.id)));
    const nextPreviews: ProjectDeletePreview[] = [];
    const nextIssues: Record<string,string> = {};
    results.forEach((result,index) => {
      const item = items[index];
      if (result.status === 'fulfilled') nextPreviews.push(result.value);
      else nextIssues[item.id] = toIssue(result.reason).message;
    });
    setPreviews(nextPreviews);setPreviewIssues(nextIssues);
    if (Object.keys(nextIssues).length) setError(Object.entries(nextIssues).map(([id,reason])=>`${items.find(item=>item.id===id)?.name ?? id}：${reason}`).join('\n'));
    setBusy(false);
  }
  async function remove() {
    if(busy||!previews.length)return;setBusy(true);setError('');
    const done:string[]=[], failures:string[]=[];
    for (const item of targets) {
      const preview = previews.find(p=>p.project_id===item.id);
      if(!preview){failures.push(`${item.name}：${previewIssues[item.id] ?? '无法读取删除范围'}`);continue;}
      try {await api.moveProjectToTrash(item.id,keyFor(`delete:${item.id}`));done.push(item.id);}catch(e){failures.push(`${item.name}：${toIssue(e).message}`);}
    }
    onDeleted(done);setSelected(s=>new Set([...s].filter(id=>!done.includes(id))));
    setMessage(done.length?`${done.length} 个项目已移到回收站`:'');
    if(failures.length){setTargets(items=>items.filter(p=>!done.includes(p.id)));setPreviews(items=>items.filter(p=>!done.includes(p.project_id)));setPreviewIssues(issues=>Object.fromEntries(Object.entries(issues).filter(([id])=>!done.includes(id))));setError(failures.join('\n'));}
    else {setDialog(null);setBulk(false);setSelected(new Set());}
    setBusy(false);
  }
  async function download() {
    setBusy(true);setError('');
    try {
      const files:{name:string;data:Uint8Array}[]=[];
      const skipped:string[]=[];
      for (let pi=0;pi<targets.length;pi++) {
        const project=targets[pi];const events=await api.listEvents(project.id);
        if(!events.length){skipped.push(`“${project.name}”还没有记录`);continue;}
        for(let ei=0;ei<events.length;ei++) {
          const event=events[ei], paragraphs:string[]=[];
          if(raw) {
            const segments=await api.listEventTranscriptSegments(event.id);
            if(!segments.length) skipped.push(`“${project.name} / ${event.title}”没有可导出的原文`);
            else paragraphs.push('原文',...transcriptParagraphs(segments,speakers,timestamps));
          }
          if(summary) {
            const result=await api.getEventAiArtifacts(event.id);
            const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
            const artifact=artifacts.filter(a=>a.kind==='summary').sort((a,b)=>b.artifact_version-a.artifact_version)[0];
            const content=artifact?.content as EventSummaryOutput | undefined;
            const summaryParagraphs:string[]=[];
            if (Array.isArray(content?.chapters) && content.chapters.length) summaryParagraphs.push('章节速览',...content.chapters.flatMap(ch=>[ch.title,ch.summary].filter((value): value is string=>Boolean(value))));
            if (Array.isArray(content?.speaker_summaries) && content.speaker_summaries.length) summaryParagraphs.push('发言总结',...content.speaker_summaries.flatMap(s=>[s.speaker ? `${s.speaker}：${s.summary}` : s.summary].filter((value): value is string=>Boolean(value))));
            if (Array.isArray(content?.key_points) && content.key_points.length) summaryParagraphs.push('要点回顾',...content.key_points.flatMap(point=>[point.question,point.answer].filter((value): value is string=>Boolean(value))));
            if (!summaryParagraphs.length && Array.isArray(content?.sections)) summaryParagraphs.push(...content.sections.flatMap(section=>[section.title,...(Array.isArray(section.items) ? section.items.map(item=>item.text) : [])].filter((value): value is string=>Boolean(value))));
            if (!summaryParagraphs.length) skipped.push(`“${project.name} / ${event.title}”没有可导出的智能速览`);
            else paragraphs.push('智能速览（自动整理，待核对）',...summaryParagraphs);
          }
          if (paragraphs.length) files.push({name:`${pi+1}-${safeName(project.name)}/${ei+1}-${safeName(event.title)}.${format}`,data:documentBytes({title:`${project.name} · ${event.title}`,paragraphs},format)});
        }
      }
      if (!files.length) throw new Error(skipped.length ? `没有可导出的内容：${skipped.join('；')}` : '没有可导出的内容');
      const bytes=zipFiles(files);const url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'}));
      const link=document.createElement('a');link.href=url;link.download=`Notique-${targets.length}个项目.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
      setDialog(null);setMessage(`已导出 ${files.length} 份文档${skipped.length?`，跳过 ${skipped.length} 项`:''}`);if(skipped.length)setError(skipped.join('\n'));
    }catch(e){setError(e instanceof Error?e.message:toIssue(e).message);}finally{setBusy(false);}
  }
  function showExport(items:Project[]) {setTargets(items);setError('');setDialog('export');}
  function editProject(project:Project,kind:'name'|'folder') {setError('');setEdit({project,name:project.name,folder:project.folderName||'',kind});}
  function menu(item:Project) {return <DropdownMenu.Root><DropdownMenu.Trigger className="pi-more" aria-label={`${item.name}的操作`}><MoreHorizontal size={19}/></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="pi-menu" align="end" sideOffset={6}>
    <DropdownMenu.Item onSelect={()=>editProject(item,'name')}><Pencil/>重命名</DropdownMenu.Item>
    <DropdownMenu.Item onSelect={()=>editProject(item,'folder')}><FolderOpen/>关联文件夹</DropdownMenu.Item>
    <DropdownMenu.Item onSelect={()=>showExport([item])}><Download/>导出</DropdownMenu.Item>
    <DropdownMenu.Separator/><DropdownMenu.Item className="pi-danger" onSelect={()=>void showDelete([item])}><Trash2/>删除</DropdownMenu.Item>
  </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>;}
  function title(item:Project) {return <button className="pi-title" title={`${item.name} · 点击重命名`} onClick={()=>editProject(item,'name')}>{item.name}</button>;}
  function association(item:Project) {return <button className="pi-folder-tag" onClick={()=>{setFolder(item.folderName||'');setSelected(new Set());}} title="查看同一文件夹"><FolderOpen size={13}/>{item.folderName||'默认文件夹'}</button>;}
  return <div className="page pi-page">
    <header className="pi-heading"><div><span className="section-kicker">工作空间</span><h1>项目</h1></div><button className="text-button pi-trash" onClick={onTrash}><Trash2 size={15}/>回收站</button></header>
    <div className="pi-search"><select aria-label="文件夹" value={folder} onChange={e=>{setFolder(e.target.value);setSelected(new Set());}}><option value="*">全部项目</option><option value="">默认文件夹</option>{folders.map(f=><option key={f}>{f}</option>)}</select><Search size={17}/><input aria-label="搜索项目" placeholder="搜索项目或文件夹…" value={query} onChange={e=>{setQuery(e.target.value);setSelected(new Set());}}/></div>
    <div className="pi-toolbar">
      {bulk?<label className="pi-select-all"><input ref={allCheckbox} type="checkbox" checked={allSelected} onChange={()=>setSelected(s=>{const next=new Set(s);for(const p of visible){if(allSelected)next.delete(p.id);else next.add(p.id);}return next;})}/>全选<span>已选择 <strong>{chosen.length}</strong> 项</span></label>:<button className="button primary" onClick={onCreate}><Plus size={17}/>新建项目</button>}
      <div className="pi-tools">{bulk?<><button disabled={!chosen.length} onClick={()=>showExport(chosen)}>导出</button><button className="pi-danger" disabled={!chosen.length} onClick={()=>void showDelete(chosen)}>删除</button><i/><button onClick={()=>{setBulk(false);setSelected(new Set());}}>取消批量</button></>:<>
        <DropdownMenu.Root><DropdownMenu.Trigger>视图<ChevronDown size={13}/></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="pi-menu" align="end" sideOffset={8}><DropdownMenu.RadioGroup value={view} onValueChange={v=>preference({view:v as 'grid'|'list'})}>{(['grid','list'] as const).map(v=><DropdownMenu.RadioItem value={v} key={v}>{v==='grid'?<LayoutGrid/>:<List/>}{v==='grid'?'卡片视图':'列表视图'}<DropdownMenu.ItemIndicator><Check/></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>)}</DropdownMenu.RadioGroup></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root><i/>
        <DropdownMenu.Root><DropdownMenu.Trigger>排序<ChevronDown size={13}/></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="pi-menu" align="end" sideOffset={8}><DropdownMenu.RadioGroup value={sort} onValueChange={v=>preference({sort:v as ProjectSort})}>{Object.entries(sortLabels).map(([key,label])=><DropdownMenu.RadioItem key={key} value={key}>{label}<DropdownMenu.ItemIndicator><Check/></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>)}</DropdownMenu.RadioGroup><DropdownMenu.Separator/><DropdownMenu.RadioGroup value={direction} onValueChange={v=>preference({direction:v as 'asc'|'desc'})}>{(['desc','asc'] as const).map(v=><DropdownMenu.RadioItem key={v} value={v}>{v==='desc'?'降序':'升序'}<DropdownMenu.ItemIndicator><Check/></DropdownMenu.ItemIndicator></DropdownMenu.RadioItem>)}</DropdownMenu.RadioGroup></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root><i/><button onClick={()=>{setBulk(true);setMessage('');}}>批量</button>
      </>}</div>
    </div>
    {message&&<div className="pi-message" role="status">{message}</div>}
    {error&&!dialog&&!edit&&<div className="pi-error" role="alert">{error}</div>}
    {state==='loading'&&<p role="status">正在读取项目…</p>}
    {state==='error'&&<div role="alert">{issue?.message}<button className="text-button" onClick={onRetry}>重试</button></div>}
    {state!=='loading'&&state!=='error'&&!visible.length&&<div className="pi-empty"><FolderOpen size={34}/><h2>{projects.length?'没有匹配的项目':'还没有项目'}</h2><p>{projects.length?'换个名称搜索，或查看全部项目。':'创建项目后，上传第一份材料开始整理。'}</p>{projects.length?<button className="button secondary" onClick={()=>{setQuery('');setFolder('*');}}>查看全部项目</button>:<button className="button primary" onClick={onCreate}>新建项目</button>}</div>}
    {visible.length>0&&<div className={`pi-collection pi-${view}`}>
      {view==='list'&&<div className="pi-table-head"><span>项目 / 文件夹</span><span>记录</span><span>{sort==='name'?'修改时间':sortLabels[sort]}</span><span>操作</span></div>}
      {visible.map(item=><article key={item.id} onClick={e=>{if(!(e.target as HTMLElement).closest('button,input,[role="menuitem"]')){if(bulk)toggle(item.id);else void open(item);}}} className={`pi-item ${selected.has(item.id)?'is-selected':''}`}>
        <div className="pi-item-top">{bulk?<input aria-label={`选择 ${item.name}`} type="checkbox" checked={selected.has(item.id)} onChange={()=>toggle(item.id)}/>:<FolderOpen className="pi-folder-icon"/>}{view==='grid'&&menu(item)}</div>
        <div className="pi-item-main">{title(item)}<div className="pi-associations">{association(item)}{Boolean(item.pendingCount)&&<span className="pi-pending">{item.pendingCount} 条待核对</span>}</div>{view==='grid'&&<button className="pi-preview" onClick={()=>bulk?toggle(item.id):void open(item)}>{item.description||item.scenario?.label||'在这里整理记录、材料和跟进'}</button>}</div>
        <span className="pi-event-count">{item.eventCount??0} 条记录</span><time className="pi-date" title={sort==='name'?'修改时间':sortLabels[sort]}>{date(item[sort==='name'?'updatedAt':sort])}</time>
        <div className="pi-item-actions">{!bulk&&<button className="pi-open" aria-label={`打开 ${item.name}`} onClick={()=>void open(item)}>打开</button>}{view==='list'&&menu(item)}</div>
      </article>)}
    </div>}
    {edit&&<Modal title={edit.kind==='name'?'重命名项目':'关联文件夹'} description={edit.kind==='name'?'名称会同步到整个工作空间。':'输入新文件夹名称，或选择已有文件夹。'} onClose={()=>setEdit(null)} dismissible={!busy}><form className="pi-dialog-body" onSubmit={e=>{e.preventDefault();void saveEdit();}}>
      <label className="field"><span>{edit.kind==='name'?'项目名称':'文件夹'}</span>{edit.kind==='name'?<input autoFocus maxLength={200} value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})}/>:<><input autoFocus list="pi-folders" maxLength={80} placeholder="默认文件夹" value={edit.folder} onChange={e=>setEdit({...edit,folder:e.target.value})}/><datalist id="pi-folders">{folders.map(f=><option key={f} value={f}/>)}</datalist></>}</label>
      {error&&<p className="pi-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={()=>setEdit(null)}>取消</button><button className="button primary" disabled={busy||!edit.name.trim()}>{busy?'正在保存…':'保存'}</button></div>
    </form></Modal>}
    {dialog==='delete'&&<Modal title={`删除${targets.length===1?'项目':` ${targets.length} 个项目`}？`} description="项目连同记录和材料移到回收站，可以恢复" onClose={()=>setDialog(null)} dismissible={!busy}>
      <div className="pi-dialog-body"><div className="pi-delete-items">{targets.map(p=><div key={p.id}><strong>{p.name}</strong><small>{`${p.eventCount??0} 条记录`}</small></div>)}</div>
      {busy&&!previews.length&&<p role="status">正在检查项目…</p>}{error&&<p className="pi-error" role="alert">{error}</p>}
      <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={()=>setDialog(null)}>取消</button>{!previews.length&&!busy?<button className="button secondary" onClick={()=>void showDelete(targets)}>重新检查</button>:<button className="button danger" disabled={busy||!previews.length} onClick={()=>void remove()}>{busy?'处理中…':'移到回收站'}</button>}</div>
    </div></Modal>}
    {dialog==='export'&&<Modal title="导出" description={`导出 ${targets.length} 个项目，按项目分文件夹`} onClose={()=>setDialog(null)} dismissible={!busy}>
      <div className="pi-dialog-body"><div className="pi-export-options"><label className="pi-export-check"><input type="checkbox" checked={raw} onChange={e=>setRaw(e.target.checked)} disabled={busy}/>原文</label>
        <div className="field"><span id="pi-export-format-label">文件格式</span>
          <Select.Root value={format} onValueChange={value=>setFormat(value as 'docx'|'txt')} disabled={busy}>
            <Select.Trigger className="pi-format-trigger" aria-labelledby="pi-export-format-label">
              <Select.Value/><Select.Icon><ChevronDown size={16}/></Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content className="pi-format-menu" position="popper" align="start" sideOffset={5} collisionPadding={12}>
                <Select.Viewport>
                  <Select.Item className="pi-format-option" value="txt"><Select.ItemText>纯文本 · .txt</Select.ItemText><Select.ItemIndicator><Check size={16}/></Select.ItemIndicator></Select.Item>
                  <Select.Item className="pi-format-option" value="docx"><Select.ItemText>Word 文档 · .docx</Select.ItemText><Select.ItemIndicator><Check size={16}/></Select.ItemIndicator></Select.Item>
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>
        {raw&&<div className="pi-export-information"><span>显示信息</span><label><input type="checkbox" checked={speakers} onChange={e=>setSpeakers(e.target.checked)} disabled={busy}/>发言人</label><label><input type="checkbox" checked={timestamps} onChange={e=>setTimestamps(e.target.checked)} disabled={busy}/>时间戳</label></div>}
        <label className="pi-export-check"><input type="checkbox" checked={summary} onChange={e=>setSummary(e.target.checked)} disabled={busy}/>智能速览</label><small>仅导出已生成的内容。原始音视频保留在项目材料中。</small></div>
      {error&&<p className="pi-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" disabled={busy} onClick={()=>setDialog(null)}>取消</button><button className="button primary" disabled={busy||(!raw&&!summary)} onClick={()=>void download()}><Download size={16}/>{busy?'正在准备文件…':'导出到本地'}</button></div>
    </div></Modal>}
  </div>;
}
