"use client";

import { useMemo, useState } from "react";

type View = "projects" | "recordings" | "inbox" | "trash" | "folder" | "agent" | "item";
type AssetType = "audio" | "image" | "document" | "note";

type Folder = {
  id: string;
  name: string;
  description: string;
  color: string;
  updated: string;
};

type Asset = {
  id: string;
  name: string;
  type: AssetType;
  meta: string;
  added: string;
  summary: string;
  folderId?: string;
};

type Suggestion = {
  folderId: string;
  confidence: number;
  reasons: string[];
};

const initialFolders: Folder[] = [
  { id: "product", name: "New Product Discovery", description: "Research, interviews and product decisions", color: "blue", updated: "Today" },
  { id: "weekly", name: "Weekly Team Sync", description: "Team meetings, plans and follow-ups", color: "purple", updated: "Yesterday" },
  { id: "interviews", name: "Customer Interviews", description: "Customer calls and research notes", color: "green", updated: "Jul 30" },
  { id: "oak", name: "Oak Street Renovation", description: "Site visits, estimates and project files", color: "amber", updated: "Jul 25" },
  { id: "course", name: "Psychology Course Notes", description: "Lectures, readings and study notes", color: "rose", updated: "Jul 24" },
  { id: "report", name: "New Report Interview", description: "Interviews and report source material", color: "slate", updated: "Jul 22" },
];

const initialAssets: Asset[] = [
  { id: "p1", name: "Customer Interview · Round 3.m4a", type: "audio", meta: "31 min · Transcript ready", added: "Today, 10:42 AM", summary: "Customer feedback about cross-meeting context and reviewable project briefs.", folderId: "product" },
  { id: "p2", name: "Product direction notes.pdf", type: "document", meta: "PDF · 4 pages", added: "Jul 30", summary: "Working product direction and questions for the next prototype.", folderId: "product" },
  { id: "p3", name: "Research debrief.m4a", type: "audio", meta: "22 min · Transcript ready", added: "Jul 29", summary: "Team debrief after the second round of interviews.", folderId: "product" },
  { id: "w1", name: "Weekly Product Review.m4a", type: "audio", meta: "46 min · Transcript ready", added: "Yesterday", summary: "Weekly team decisions, blockers and owners.", folderId: "weekly" },
  { id: "i1", name: "Interview · Sarah Chen.m4a", type: "audio", meta: "28 min · Transcript ready", added: "Jul 28", summary: "Customer interview about meeting notes and deliverables.", folderId: "interviews" },
  { id: "o1", name: "Site Walkthrough 02.m4a", type: "audio", meta: "24 min · Transcript ready", added: "Jul 25", summary: "Kitchen wall removal, electrical scope and working budget.", folderId: "oak" },
  { id: "o2", name: "Kitchen estimate.pdf", type: "document", meta: "PDF · 6 pages", added: "Jul 24", summary: "Estimate for wall removal and drywall repair.", folderId: "oak" },
  { id: "c1", name: "Lecture 08.m4a", type: "audio", meta: "58 min · Transcript ready", added: "Jul 24", summary: "Lecture recording and study notes.", folderId: "course" },
  { id: "r1", name: "Eric interview.m4a", type: "audio", meta: "37 min · Transcript ready", added: "Jul 22", summary: "Interview source for the new report.", folderId: "report" },
];

const initialInbox: Asset[] = [
  { id: "inbox-1", name: "Team planning notes.pdf", type: "document", meta: "PDF · 3 pages", added: "Today, 9:18 AM", summary: "Planning notes mentioning the weekly team agenda, owners and next Friday." },
  { id: "inbox-2", name: "IMG_1842.jpg", type: "image", meta: "JPG · 3.8 MB", added: "Yesterday", summary: "A site photo showing the kitchen wall and electrical outlet." },
];

const samples: Asset[] = [
  { id: "sample-audio", name: "Customer Interview · Round 4.m4a", type: "audio", meta: "34 min · Sample file", added: "Just now", summary: "Interview about project memory, product workflow and user testing." },
  { id: "sample-photo", name: "Oak Street site photo 04.jpg", type: "image", meta: "JPG · Sample file", added: "Just now", summary: "Kitchen wall, electrical outlet and drywall captured during a site visit." },
  { id: "sample-doc", name: "Friday team planning.docx", type: "document", meta: "DOCX · Sample file", added: "Just now", summary: "Weekly planning notes with owners, blockers and next steps." },
];

function typeIcon(type: AssetType) {
  return { audio: "♪", image: "▧", document: "▤", note: "✎" }[type];
}

function suggestionsFor(asset: Asset): Suggestion[] {
  const text = `${asset.name} ${asset.summary}`.toLowerCase();
  if (text.includes("oak") || text.includes("site") || text.includes("kitchen") || text.includes("wall")) {
    return [
      { folderId: "oak", confidence: 94, reasons: ["Oak Street appears in the file name", "The image matches kitchen and site-visit content"] },
      { folderId: "interviews", confidence: 42, reasons: ["The item may be supporting material from a customer conversation"] },
    ];
  }
  if (text.includes("weekly") || text.includes("friday") || text.includes("team") || text.includes("planning")) {
    return [
      { folderId: "weekly", confidence: 91, reasons: ["The document mentions the weekly agenda", "Owners and next steps match recent team meetings"] },
      { folderId: "product", confidence: 68, reasons: ["Several notes also refer to the current product work"] },
    ];
  }
  return [
    { folderId: "product", confidence: 89, reasons: ["The transcript discusses product workflow and user testing", "Two recent recordings in this project mention the same topics"] },
    { folderId: "interviews", confidence: 76, reasons: ["The file is a customer interview", "The speaker and format match this research collection"] },
  ];
}

export default function Home() {
  const [view, setView] = useState<View>("projects");
  const [folders, setFolders] = useState(initialFolders);
  const [assets, setAssets] = useState(initialAssets);
  const [inbox, setInbox] = useState(initialInbox);
  const [trash, setTrash] = useState<Asset[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState("product");
  const [selectedAssetId, setSelectedAssetId] = useState("p1");
  const [stagedAsset, setStagedAsset] = useState<Asset | null>(null);
  const [selectedSuggestion, setSelectedSuggestion] = useState("product");
  const [agentReady, setAgentReady] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [renameKind, setRenameKind] = useState<"folder" | "asset">("asset");
  const [renameValue, setRenameValue] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lastFiledId, setLastFiledId] = useState<string | null>(null);

  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) || folders[0];
  const selectedAsset = [...assets, ...inbox, ...trash].find((asset) => asset.id === selectedAssetId) || assets[0];
  const folderAssets = assets.filter((asset) => asset.folderId === selectedFolder.id);
  const suggestions = stagedAsset ? suggestionsFor(stagedAsset) : [];
  const allRecordings = assets.filter((asset) => asset.type === "audio");

  const folderCounts = useMemo(() => Object.fromEntries(folders.map((folder) => [folder.id, assets.filter((asset) => asset.folderId === folder.id).length])), [folders, assets]);

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2200);
  }

  function openFolder(id: string) {
    setSelectedFolderId(id);
    setView("folder");
  }

  function openItem(id: string) {
    setSelectedAssetId(id);
    setView("item");
  }

  function startAgent(asset: Asset) {
    const copy = { ...asset, id: asset.id.startsWith("sample") ? `new-${Date.now()}` : asset.id };
    const next = suggestionsFor(copy);
    setStagedAsset(copy);
    setSelectedSuggestion(next[0].folderId);
    setAgentReady(false);
    setShowImport(false);
    setView("agent");
    window.setTimeout(() => setAgentReady(true), 900);
  }

  function handleFile(file: File) {
    const type: AssetType = file.type.startsWith("audio") ? "audio" : file.type.startsWith("image") ? "image" : "document";
    startAgent({ id: `upload-${Date.now()}`, name: file.name, type, meta: `${Math.max(1, Math.round(file.size / 1024))} KB · Uploaded file`, added: "Just now", summary: "Notique extracted the title, available text, transcript cues and recent project context." });
  }

  function allowFiling() {
    if (!stagedAsset) return;
    const filed = { ...stagedAsset, folderId: selectedSuggestion, added: "Just now" };
    setAssets((items) => [...items.filter((item) => item.id !== filed.id), filed]);
    setInbox((items) => items.filter((item) => item.id !== filed.id));
    setLastFiledId(filed.id);
    setSelectedFolderId(selectedSuggestion);
    setSelectedAssetId(filed.id);
    setStagedAsset(null);
    setView("folder");
    flash(`Filed in ${folders.find((folder) => folder.id === selectedSuggestion)?.name}`);
  }

  function keepInInbox() {
    if (stagedAsset && !inbox.some((item) => item.id === stagedAsset.id)) setInbox((items) => [{ ...stagedAsset, folderId: undefined }, ...items]);
    setStagedAsset(null);
    setView("inbox");
    flash("Kept in Inbox");
  }

  function moveToTrash(asset: Asset) {
    setAssets((items) => items.filter((item) => item.id !== asset.id));
    setInbox((items) => items.filter((item) => item.id !== asset.id));
    setTrash((items) => [{ ...asset }, ...items]);
    setMenuId(null);
    flash("Moved to Trash");
  }

  function restoreAsset(asset: Asset) {
    setTrash((items) => items.filter((item) => item.id !== asset.id));
    if (asset.folderId) setAssets((items) => [...items, asset]);
    else setInbox((items) => [...items, asset]);
    flash("Item restored");
  }

  function openRename(kind: "folder" | "asset", value: string, id: string) {
    setRenameKind(kind);
    setRenameValue(value);
    if (kind === "folder") setSelectedFolderId(id); else setSelectedAssetId(id);
    setMenuId(null);
    setShowRename(true);
  }

  function saveRename() {
    const value = renameValue.trim();
    if (!value) return;
    if (renameKind === "folder") setFolders((items) => items.map((item) => item.id === selectedFolderId ? { ...item, name: value } : item));
    else {
      setAssets((items) => items.map((item) => item.id === selectedAssetId ? { ...item, name: value } : item));
      setInbox((items) => items.map((item) => item.id === selectedAssetId ? { ...item, name: value } : item));
    }
    setShowRename(false);
    flash("Name updated");
  }

  function Sidebar() {
    return (
      <aside className="sidebar">
        <button className="logo" onClick={() => setView("projects")}><span>⌁</span>Notique AI</button>
        <div className="account"><span className="avatar">A</span><span><strong>Aaron</strong><small>aaron@notiqueai.com</small></span><b>⌄</b></div>
        <button className="search-button" onClick={() => flash("Search is ready")}>⌕ <span>Search</span></button>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          <button className={["projects", "folder", "item"].includes(view) ? "nav-item active" : "nav-item"} onClick={() => setView("projects")}><span>▣</span>Projects<b>{folders.length}</b></button>
          <button className={view === "recordings" ? "nav-item active" : "nav-item"} onClick={() => setView("recordings")}><span>♪</span>Recordings<b>{allRecordings.length}</b></button>
          <button className={["inbox", "agent"].includes(view) ? "nav-item active" : "nav-item"} onClick={() => setView("inbox")}><span>▤</span>Inbox<b className={inbox.length ? "blue-count" : ""}>{inbox.length}</b></button>
          <button className={view === "trash" ? "nav-item active" : "nav-item"} onClick={() => setView("trash")}><span>♲</span>Trash<b>{trash.length}</b></button>
        </nav>
        <p className="nav-label resources">RESOURCES</p>
        <nav>
          <button className="nav-item" onClick={() => flash("Explore Notique AI")}>◎ <span>Explore Notique AI</span></button>
          <button className="nav-item" onClick={() => flash("AI templates")}>▦ <span>AI templates</span></button>
          <button className="nav-item" onClick={() => flash("My templates")}>▧ <span>My templates</span></button>
        </nav>
        <div className="spacer" />
        <button className="upgrade">Upgrade plan</button>
      </aside>
    );
  }

  function Toolbar({ title, count, action = "none" }: { title: string; count?: number; action?: "project" | "import" | "none" }) {
    return <header className="toolbar"><h1>{title}{typeof count === "number" && <span> ({count})</span>}</h1><div><button className="sort">Updated time⌄</button>{action === "project" && <button className="primary" onClick={() => setShowNewProject(true)}>New project</button>}{action === "import" && <button className="primary" onClick={() => setShowImport(true)}>Import</button>}</div></header>;
  }

  function ProjectsView() {
    return <div className="page"><Toolbar title="Projects" count={folders.length} action="project"/><div className="folder-grid">{folders.map((folder) => <article className="folder-card" key={folder.id} role="button" tabIndex={0} onClick={() => openFolder(folder.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openFolder(folder.id); }}><span className={`folder-tab ${folder.color}`}/><button className="more" aria-label={`More options for ${folder.name}`} onClick={(event) => { event.stopPropagation(); setMenuId(menuId === folder.id ? null : folder.id); }}>•••</button><strong>{folder.name}</strong><small>{folder.description}</small><span className="folder-meta">{folderCounts[folder.id] || 0} items · {folder.updated}</span>{menuId === folder.id && <span className="menu"><b onClick={(event) => { event.stopPropagation(); openRename("folder", folder.name, folder.id); }}>Rename</b><b className="danger">Delete</b></span>}</article>)}</div></div>;
  }

  function RecordingsView() {
    return <div className="page"><Toolbar title="Recordings" count={allRecordings.length} action="import"/><div className="recording-grid">{allRecordings.map((asset) => <article className="recording-card" key={asset.id}><button className="play" onClick={() => openItem(asset.id)}>▶</button><span><strong>{asset.name}</strong><small>{folders.find((folder) => folder.id === asset.folderId)?.name}</small><b>{asset.meta}</b></span><button className="more" onClick={() => setMenuId(menuId === asset.id ? null : asset.id)}>•••</button>{menuId === asset.id && <div className="menu card-menu"><button onClick={() => openRename("asset", asset.name, asset.id)}>Rename</button><button className="danger" onClick={() => moveToTrash(asset)}>Move to Trash</button></div>}</article>)}</div></div>;
  }

  function InboxView() {
    return <div className="page"><Toolbar title="Inbox" count={inbox.length} action="import"/><div className="inbox-intro"><span className="sparkle">✦</span><span><strong>Let Notique file new content for you</strong><small>AI suggests two likely projects. Nothing moves until you allow it.</small></span><button className="secondary" onClick={() => setShowImport(true)}>Add something</button></div>{inbox.length ? <div className="content-table"><div className="table-head"><span>Name</span><span>Added</span><span>Status</span><span/></div>{inbox.map((asset) => <div className="table-row" key={asset.id}><span className="name-cell"><b className={`type-icon ${asset.type}`}>{typeIcon(asset.type)}</b><span><strong>{asset.name}</strong><small>{asset.meta}</small></span></span><span>{asset.added}</span><span className="unfiled">Not filed</span><button className="agent-button" onClick={() => startAgent(asset)}>File with AI</button></div>)}</div> : <div className="empty"><span>✓</span><h2>Inbox is clear</h2><p>New imports that need a project will appear here.</p><button className="primary" onClick={() => setShowImport(true)}>Import something</button></div>}</div>;
  }

  function TrashView() {
    return <div className="page"><Toolbar title="Trash" count={trash.length}/>{trash.length ? <div className="content-table"><div className="table-head"><span>Name</span><span>Deleted</span><span>Original project</span><span/></div>{trash.map((asset) => <div className="table-row" key={asset.id}><span className="name-cell"><b className={`type-icon ${asset.type}`}>{typeIcon(asset.type)}</b><span><strong>{asset.name}</strong><small>{asset.meta}</small></span></span><span>Just now</span><span>{folders.find((folder) => folder.id === asset.folderId)?.name || "Inbox"}</span><button className="secondary" onClick={() => restoreAsset(asset)}>Restore</button></div>)}</div> : <div className="empty"><span>♲</span><h2>Trash is empty</h2><p>Deleted items stay here for 30 days.</p></div>}</div>;
  }

  function FolderView() {
    return <div className="page folder-page"><button className="back" onClick={() => setView("projects")}>‹ Projects</button><header className="folder-header"><div><h1>{selectedFolder.name}</h1><p>{selectedFolder.description}</p></div><div><button className="secondary" onClick={() => openRename("folder", selectedFolder.name, selectedFolder.id)}>Rename</button><button className="primary" onClick={() => setShowImport(true)}>Add</button></div></header><div className="folder-summary"><span><strong>{folderAssets.length}</strong><small>Items</small></span><span><strong>{folderAssets.filter((item) => item.type === "audio").length}</strong><small>Recordings</small></span><span><strong>{folderAssets.filter((item) => item.type !== "audio").length}</strong><small>Files and notes</small></span></div><div className="content-table folder-table"><div className="table-head"><span>Name</span><span>Type</span><span>Added</span><span/></div>{folderAssets.map((asset) => <div className={asset.id === lastFiledId ? "table-row newly-filed" : "table-row"} key={asset.id}><button className="name-cell" onClick={() => openItem(asset.id)}><b className={`type-icon ${asset.type}`}>{typeIcon(asset.type)}</b><span><strong>{asset.name}</strong><small>{asset.summary}</small></span></button><span className="type-label">{asset.type}</span><span>{asset.added}</span><div className="row-actions">{asset.id === lastFiledId && <span className="filed-badge">Filed by AI</span>}<button className="more inline" onClick={() => setMenuId(menuId === asset.id ? null : asset.id)}>•••</button>{menuId === asset.id && <div className="menu card-menu"><button onClick={() => openRename("asset", asset.name, asset.id)}>Rename</button><button className="danger" onClick={() => moveToTrash(asset)}>Move to Trash</button></div>}</div></div>)}</div></div>;
  }

  function AgentView() {
    const selected = suggestions.find((suggestion) => suggestion.folderId === selectedSuggestion) || suggestions[0];
    return <div className="agent-page"><button className="back" onClick={keepInInbox}>‹ Back to Inbox</button><div className="agent-title"><span className="agent-mark">✦</span><div><h1>Where should this go?</h1><p>Notique checks the item and your recent project activity. You make the final choice.</p></div></div>{stagedAsset && <article className="asset-preview"><b className={`type-icon large ${stagedAsset.type}`}>{typeIcon(stagedAsset.type)}</b><span><strong>{stagedAsset.name}</strong><small>{stagedAsset.meta}</small></span><button onClick={() => flash("Preview generated from the imported item")}>Preview</button></article>}{!agentReady ? <section className="analyzing"><span className="spinner"/><h2>Finding the best project</h2><p>Reading the title, available content and recent project context.</p></section> : <><section className="suggestion-section"><header><div><h2>Two likely projects</h2><p>Select one, then allow Notique to file the item.</p></div><span>AI suggestion</span></header><div className="suggestions">{suggestions.map((suggestion, index) => { const folder = folders.find((item) => item.id === suggestion.folderId)!; const active = selectedSuggestion === suggestion.folderId; return <button className={active ? "suggestion active" : "suggestion"} key={suggestion.folderId} onClick={() => setSelectedSuggestion(suggestion.folderId)}><span className="radio">{active ? "●" : ""}</span><span className={`mini-folder ${folder.color}`}>▰</span><span className="suggestion-copy"><span><b>{index === 0 ? "BEST MATCH" : "ALSO POSSIBLE"}</b><em>{suggestion.confidence}% match</em></span><strong>{folder.name}</strong><small>{folder.description}</small><ul>{suggestion.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></span></button>})}</div></section><section className="agent-confirm"><span><strong>File in {folders.find((folder) => folder.id === selected?.folderId)?.name}</strong><small>You can move or rename it later.</small></span><button className="text-button" onClick={keepInInbox}>Keep in Inbox</button><button className="primary allow" onClick={allowFiling}>Allow and file</button></section></>}</div>;
  }

  function ItemView() {
    const parent = folders.find((folder) => folder.id === selectedAsset.folderId);
    return <div className="page item-page"><button className="back" onClick={() => parent ? openFolder(parent.id) : setView("inbox")}>‹ {parent?.name || "Inbox"}</button><header className="item-header"><span className={`type-icon hero ${selectedAsset.type}`}>{typeIcon(selectedAsset.type)}</span><div><h1>{selectedAsset.name}</h1><p>{selectedAsset.meta} · {selectedAsset.added}</p></div><button className="secondary" onClick={() => openRename("asset", selectedAsset.name, selectedAsset.id)}>Rename</button></header><div className="item-layout"><article className="item-main"><h2>Summary</h2><p>{selectedAsset.summary}</p>{selectedAsset.type === "audio" && <><h2>Transcript preview</h2><blockquote>“The project view matters because the details build up over more than one conversation. I still want to approve where things go.”</blockquote><button className="secondary">Open full transcript</button></>}</article><aside><h3>Project</h3><button onClick={() => parent && openFolder(parent.id)}><span className={`mini-folder ${parent?.color || "slate"}`}>▰</span><span><strong>{parent?.name || "Not filed"}</strong><small>{parent ? "Filed in this project" : "Waiting in Inbox"}</small></span></button><h3>Details</h3><p>Type <b>{selectedAsset.type}</b></p><p>Added <b>{selectedAsset.added}</b></p></aside></div></div>;
  }

  function Content() {
    if (view === "projects") return <ProjectsView/>;
    if (view === "recordings") return <RecordingsView/>;
    if (view === "inbox") return <InboxView/>;
    if (view === "trash") return <TrashView/>;
    if (view === "folder") return <FolderView/>;
    if (view === "agent") return <AgentView/>;
    return <ItemView/>;
  }

  return <div className="app-shell"><Sidebar/><header className="mobile-header"><button onClick={() => setView("projects")}>⌁ Notique AI</button><button onClick={() => setShowImport(true)}>＋</button></header><main><Content/></main><nav className="mobile-nav"><button onClick={() => setView("projects")}>▣<small>Projects</small></button><button onClick={() => setView("recordings")}>♪<small>Recordings</small></button><button onClick={() => setView("inbox")}>▤<small>Inbox</small></button><button onClick={() => setShowImport(true)}>＋<small>Import</small></button></nav>

    {showImport && <div className="modal-backdrop" onMouseDown={() => setShowImport(false)}><section className="modal import-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>Add to Notique</h2><p>Drop in a recording, photo or document.</p></div><button onClick={() => setShowImport(false)}>×</button></header><label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) handleFile(file); }}><input type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) handleFile(file); }}/><span className="upload-icon">↥</span><strong>Drop a file here</strong><small>or click to choose from your computer</small></label><p className="sample-label">TRY THE COMPLETE FLOW</p><div className="sample-list">{samples.map((sample) => <button key={sample.id} onClick={() => startAgent(sample)}><b className={`type-icon ${sample.type}`}>{typeIcon(sample.type)}</b><span><strong>{sample.name}</strong><small>{sample.meta}</small></span><em>Use sample</em></button>)}</div></section></div>}

    {showNewProject && <div className="modal-backdrop" onMouseDown={() => setShowNewProject(false)}><section className="modal small-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>New project</h2><p>Keep related recordings, files and notes together.</p></div><button onClick={() => setShowNewProject(false)}>×</button></header><label>Project name</label><input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Untitled project"/><div className="modal-actions"><button className="secondary" onClick={() => setShowNewProject(false)}>Cancel</button><button className="primary" onClick={() => { const name = newProjectName.trim(); if (!name) return; const id = `folder-${Date.now()}`; setFolders((items) => [...items, { id, name, description: "Recordings, files and notes", color: "slate", updated: "Just now" }]); setSelectedFolderId(id); setNewProjectName(""); setShowNewProject(false); setView("folder"); flash("Project created"); }}>Create project</button></div></section></div>}

    {showRename && <div className="modal-backdrop" onMouseDown={() => setShowRename(false)}><section className="modal small-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>Rename {renameKind}</h2></div><button onClick={() => setShowRename(false)}>×</button></header><label>Name</label><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)}/><div className="modal-actions"><button className="secondary" onClick={() => setShowRename(false)}>Cancel</button><button className="primary" onClick={saveRename}>Save</button></div></section></div>}
    {toast && <div className="toast">✓ {toast}</div>}
  </div>;
}
