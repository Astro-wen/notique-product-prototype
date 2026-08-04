"use client";

import { useMemo, useState } from "react";

type View =
  | "projects"
  | "recordings"
  | "inbox"
  | "trash"
  | "folder"
  | "item"
  | "agent"
  | "workspace"
  | "event"
  | "review"
  | "claim"
  | "compare"
  | "deliverables"
  | "templates";

type Modal =
  | "import"
  | "newProject"
  | "rename"
  | "search"
  | "transcript"
  | "share"
  | "newDeliverable"
  | "upgrade"
  | "deleteFolder"
  | "evidence"
  | null;

type AssetType = "audio" | "image" | "document" | "note";
type ProjectKind = "general" | "contractor";
type ClaimState = "pending" | "confirmed" | "edited" | "rejected";
type ReviewFilter = "pending" | "reviewed" | "all";

type Folder = {
  id: string;
  name: string;
  description: string;
  color: string;
  updated: string;
  kind: ProjectKind;
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

type Claim = {
  id: string;
  category: string;
  field: string;
  proposed: string;
  previous: string;
  reason: string;
  quote: string;
  againstQuote?: string;
  time: string;
  impact: string;
  risk: "high" | "medium" | "low";
  state: ClaimState;
  editedReason?: string;
};

const initialFolders: Folder[] = [
  { id: "product", name: "New Product Discovery", description: "Research, interviews and product decisions", color: "blue", updated: "Today", kind: "general" },
  { id: "weekly", name: "Weekly Team Sync", description: "Team meetings, plans and follow-ups", color: "purple", updated: "Yesterday", kind: "general" },
  { id: "interviews", name: "Customer Interviews", description: "Customer calls and research notes", color: "green", updated: "Jul 30", kind: "general" },
  { id: "oak", name: "Oak Street Renovation", description: "Site visits, estimates and project files", color: "amber", updated: "Jul 25", kind: "contractor" },
  { id: "course", name: "Psychology Course Notes", description: "Lectures, readings and study notes", color: "rose", updated: "Jul 24", kind: "general" },
  { id: "report", name: "New Report Interview", description: "Interviews and report source material", color: "slate", updated: "Jul 22", kind: "general" },
];

const initialAssets: Asset[] = [
  { id: "p1", name: "Customer Interview · Round 3.m4a", type: "audio", meta: "31 min · Transcript ready", added: "Today, 10:42 AM", summary: "Customer feedback about cross-meeting context and reviewable project briefs.", folderId: "product" },
  { id: "p2", name: "Product direction notes.pdf", type: "document", meta: "PDF · 4 pages", added: "Jul 30", summary: "Working product direction and questions for the next prototype.", folderId: "product" },
  { id: "p3", name: "Research debrief.m4a", type: "audio", meta: "22 min · Transcript ready", added: "Jul 29", summary: "Team debrief after the second round of interviews.", folderId: "product" },
  { id: "p4", name: "Interview screenshots", type: "image", meta: "4 images", added: "Jul 29", summary: "Screenshots referenced during the customer interviews.", folderId: "product" },
  { id: "w1", name: "Weekly Product Review.m4a", type: "audio", meta: "46 min · Transcript ready", added: "Yesterday", summary: "Weekly team decisions, blockers and owners.", folderId: "weekly" },
  { id: "i1", name: "Interview · Sarah Chen.m4a", type: "audio", meta: "28 min · Transcript ready", added: "Jul 28", summary: "Customer interview about meeting notes and deliverables.", folderId: "interviews" },
  { id: "o1", name: "Site Walkthrough 02.m4a", type: "audio", meta: "24 min · Transcript ready", added: "Jul 25", summary: "Kitchen wall removal, electrical scope and working budget.", folderId: "oak" },
  { id: "o2", name: "Kitchen estimate.pdf", type: "document", meta: "PDF · 6 pages", added: "Jul 24", summary: "Estimate for wall removal and drywall repair.", folderId: "oak" },
  { id: "o3", name: "Site photo 03.jpg", type: "image", meta: "JPG · 4.1 MB", added: "Jul 25", summary: "Kitchen wall, outlet and possible hidden wiring captured during the walkthrough.", folderId: "oak" },
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

const claimSeeds: Record<ProjectKind, Claim[]> = {
  general: [
    {
      id: "audience",
      category: "Audience",
      field: "Primary audience",
      proposed: "Consultants and project teams managing work across several meetings",
      previous: "Contractors were the first research group",
      reason: "The latest interview broadened the audience beyond one profession.",
      quote: "The project view is useful because my decisions are spread across several conversations.",
      time: "12:18",
      impact: "Updates the Project Brief and test recruiting criteria.",
      risk: "medium",
      state: "pending",
    },
    {
      id: "deliverable",
      category: "Output",
      field: "First deliverable",
      proposed: "A source-linked project brief that can be reviewed and shared",
      previous: "A meeting summary",
      reason: "The user described the final document, not the transcript, as the work product.",
      quote: "I need something I can send, but I still need to know where every important point came from.",
      time: "18:42",
      impact: "Changes the default deliverable for this project.",
      risk: "high",
      state: "pending",
    },
    {
      id: "pilot",
      category: "Schedule",
      field: "Next test",
      proposed: "Test the clickable project flow with five existing users in August",
      previous: "No test date recorded",
      reason: "A concrete next step and timing were stated in the latest discussion.",
      quote: "Let us put the current flow in front of five users next month.",
      time: "27:06",
      impact: "Adds a dated task to the Action Checklist.",
      risk: "low",
      state: "pending",
    },
    {
      id: "owner",
      category: "Responsibility",
      field: "Prototype owner",
      proposed: "Aaron owns the first clickable prototype; Kevin supplies the latest UI reference",
      previous: "Owner not recorded",
      reason: "The latest meeting assigned the work and clarified the dependency.",
      quote: "Aaron can build the flow while Kevin sends over the current UI screens.",
      time: "29:14",
      impact: "Adds owners to the Action Checklist.",
      risk: "low",
      state: "confirmed",
    },
  ],
  contractor: [
    {
      id: "electrical",
      category: "Scope",
      field: "Electrical scope",
      proposed: "Hidden-line rewiring is not included in the original estimate",
      previous: "Client believed electrical work was included",
      reason: "Two conversations conflict and the difference affects price and approval.",
      quote: "The electrical behind that wall was not part of the original number.",
      againstQuote: "When we first spoke, I understood that the electrical was included.",
      time: "16:21",
      impact: "Blocks the Change Order and Scope Checklist until reviewed.",
      risk: "high",
      state: "pending",
    },
    {
      id: "price",
      category: "Money",
      field: "Working price",
      proposed: "$3,400",
      previous: "$2,850",
      reason: "The new amount differs by $550 and is still waiting for written confirmation.",
      quote: "With the extra electrical work, the revised total is thirty-four hundred.",
      time: "18:42",
      impact: "Updates the Change Order total after confirmation.",
      risk: "high",
      state: "pending",
    },
    {
      id: "approval",
      category: "Approval",
      field: "Start condition",
      proposed: "Do not begin work until the client signs the Change Order",
      previous: "General written approval before work",
      reason: "The latest walkthrough made the Change Order a specific start condition.",
      quote: "We should not open the wall until the change order is signed.",
      time: "20:06",
      impact: "Creates a required checklist item.",
      risk: "medium",
      state: "pending",
    },
    {
      id: "photos",
      category: "Evidence",
      field: "Photo requirement",
      proposed: "Attach before and after photos to the Change Order record",
      previous: "Only completion photos were requested",
      reason: "The new evidence requirement can be made an executable checklist field.",
      quote: "Please take a picture before you open it and another one when it is done.",
      time: "21:14",
      impact: "Adds two evidence requirements to the Scope Checklist.",
      risk: "low",
      state: "confirmed",
    },
    {
      id: "owner",
      category: "Responsibility",
      field: "Document owner",
      proposed: "Maria prepares the Change Order by Jul 28",
      previous: "Maria was generally supporting the project",
      reason: "The latest event assigned a clear document owner and date.",
      quote: "Maria will prepare the change order by Tuesday.",
      time: "22:30",
      impact: "Adds an owner and due date to the Change Order.",
      risk: "low",
      state: "confirmed",
    },
  ],
};

const generalChecklist = [
  "Confirm the primary audience for the next test",
  "Review the source-linked Project Brief structure",
  "Prepare the clickable prototype",
  "Recruit five existing users",
  "Record completion time, errors and comments",
];

const contractorChecklist = [
  "Obtain the signed client Change Order",
  "Protect the adjacent kitchen and dining area",
  "Remove the short wall and repair drywall",
  "Confirm whether hidden-line rewiring is included",
  "Attach before and after photos",
];

function typeIcon(type: AssetType) {
  return { audio: "♪", image: "▧", document: "▤", note: "✎" }[type];
}

function suggestionsFor(asset: Asset): Suggestion[] {
  const text = `${asset.name} ${asset.summary}`.toLowerCase();
  if (text.includes("oak") || text.includes("site") || text.includes("kitchen") || text.includes("wall")) {
    return [
      { folderId: "oak", confidence: 94, reasons: ["The file refers to Oak Street or a site visit", "The content matches the kitchen and wall-removal context"] },
      { folderId: "interviews", confidence: 42, reasons: ["It may also be supporting material from a customer conversation"] },
    ];
  }
  if (text.includes("weekly") || text.includes("friday") || text.includes("team") || text.includes("planning")) {
    return [
      { folderId: "weekly", confidence: 91, reasons: ["The document matches the weekly planning agenda", "Owners and follow-ups overlap with recent team meetings"] },
      { folderId: "product", confidence: 68, reasons: ["Several notes also refer to the current product work"] },
    ];
  }
  return [
    { folderId: "product", confidence: 89, reasons: ["The transcript discusses product workflow and user testing", "Two recent recordings in this project mention the same topics"] },
    { folderId: "interviews", confidence: 76, reasons: ["The item is a customer interview", "The speaker and format match this research collection"] },
  ];
}

function Status({ state }: { state: ClaimState }) {
  const label = { pending: "Needs review", confirmed: "Confirmed", edited: "Edited", rejected: "Not added" }[state];
  return <span className={`status status-${state}`}>{label}</span>;
}

export default function Home() {
  const [view, setView] = useState<View>("projects");
  const [modal, setModal] = useState<Modal>(null);
  const [folders, setFolders] = useState(initialFolders);
  const [assets, setAssets] = useState(initialAssets);
  const [inbox, setInbox] = useState(initialInbox);
  const [trash, setTrash] = useState<Asset[]>([]);
  const [claimsByKind, setClaimsByKind] = useState<Record<ProjectKind, Claim[]>>({
    general: claimSeeds.general.map((claim) => ({ ...claim })),
    contractor: claimSeeds.contractor.map((claim) => ({ ...claim })),
  });
  const [selectedFolderId, setSelectedFolderId] = useState("product");
  const [selectedAssetId, setSelectedAssetId] = useState("p1");
  const [selectedClaimId, setSelectedClaimId] = useState("audience");
  const [projectKind, setProjectKind] = useState<ProjectKind>("general");
  const [stagedAsset, setStagedAsset] = useState<Asset | null>(null);
  const [selectedSuggestion, setSelectedSuggestion] = useState("product");
  const [agentReady, setAgentReady] = useState(true);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("pending");
  const [showRename, setShowRename] = useState(false);
  const [renameKind, setRenameKind] = useState<"folder" | "asset">("asset");
  const [renameValue, setRenameValue] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lastFiledId, setLastFiledId] = useState<string | null>(null);
  const [sortNewest, setSortNewest] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState("");
  const [editReason, setEditReason] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const [askText, setAskText] = useState("");
  const [askAnswer, setAskAnswer] = useState("");
  const [activeDeliverable, setActiveDeliverable] = useState(1);
  const [savedDeliverables, setSavedDeliverables] = useState<number[]>([]);
  const [checklistDone, setChecklistDone] = useState<Record<number, boolean>>({ 0: true });
  const [checklistEvidence, setChecklistEvidence] = useState<Record<number, boolean>>({});
  const [evidenceTask, setEvidenceTask] = useState(0);
  const [templateMode, setTemplateMode] = useState("AI templates");
  const [accountOpen, setAccountOpen] = useState(false);

  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) || folders[0];
  const selectedAsset = [...assets, ...inbox, ...trash].find((asset) => asset.id === selectedAssetId) || assets[0];
  const folderAssets = assets.filter((asset) => asset.folderId === selectedFolder.id);
  const suggestions = stagedAsset ? suggestionsFor(stagedAsset) : [];
  const allRecordings = assets.filter((asset) => asset.type === "audio");
  const claims = claimsByKind[projectKind];
  const selectedClaim = claims.find((claim) => claim.id === selectedClaimId) || claims[0];
  const pendingCount = claims.filter((claim) => claim.state === "pending").length;
  const checklist = projectKind === "contractor" ? contractorChecklist : generalChecklist;
  const folderCounts = useMemo(
    () => Object.fromEntries(folders.map((folder) => [folder.id, assets.filter((asset) => asset.folderId === folder.id).length])),
    [folders, assets],
  );

  const profile = projectKind === "contractor"
    ? {
        title: selectedFolder.name,
        meta: "100 Main Street · 4 events · 5 files",
        event: "Site Walkthrough 02",
        eventMeta: "Jul 25, 2026 · 24 min · Aaron, client and Maria",
        goal: "Complete the wall removal with an approved scope, price and evidence record",
      }
    : {
        title: selectedFolder.name,
        meta: `${folderCounts[selectedFolder.id] || 0} items · 4 events · updated ${selectedFolder.updated.toLowerCase()}`,
        event: "Customer Interview · Round 3",
        eventMeta: "Jul 31, 2026 · 31 min · Aaron and customer",
        goal: "Turn research across several conversations into a reviewable product decision",
      };

  const overview = projectKind === "contractor"
    ? [
        { label: "Scope", value: "Remove the short wall and repair affected drywall", claimId: "electrical" },
        { label: "Working price", value: claims.find((claim) => claim.id === "price")?.state === "pending" ? "$2,850 recorded · $3,400 needs review" : claims.find((claim) => claim.id === "price")?.proposed || "$3,400", claimId: "price" },
        { label: "Approval", value: "Signed Change Order required before work begins", claimId: "approval" },
        { label: "Owner", value: "Maria prepares the Change Order by Jul 28", claimId: "owner" },
      ]
    : [
        { label: "Goal", value: profile.goal },
        { label: "Audience", value: claims.find((claim) => claim.id === "audience")?.state === "pending" ? "Audience update needs review" : claims.find((claim) => claim.id === "audience")?.proposed || "Project teams", claimId: "audience" },
        { label: "Output", value: claims.find((claim) => claim.id === "deliverable")?.state === "pending" ? "Source-linked Project Brief needs review" : claims.find((claim) => claim.id === "deliverable")?.proposed || "Project Brief", claimId: "deliverable" },
        { label: "Next step", value: claims.find((claim) => claim.id === "pilot")?.state === "pending" ? "August user test needs review" : claims.find((claim) => claim.id === "pilot")?.proposed || "User test", claimId: "pilot" },
      ];

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2200);
  }

  function openFolder(id: string) {
    setSelectedFolderId(id);
    setMenuId(null);
    setView("folder");
  }

  function openWorkspace(id = selectedFolderId) {
    const folder = folders.find((item) => item.id === id) || selectedFolder;
    setSelectedFolderId(folder.id);
    setProjectKind(folder.kind);
    setSelectedClaimId(claimSeeds[folder.kind][0].id);
    setReviewFilter("pending");
    setView("workspace");
  }

  function openItem(id: string) {
    setSelectedAssetId(id);
    setView("item");
  }

  function openClaim(id: string) {
    setSelectedClaimId(id);
    setEditMode(false);
    setAskOpen(false);
    setAskAnswer("");
    setView("claim");
  }

  function startAgent(asset: Asset) {
    const copy = { ...asset, id: asset.id.startsWith("sample") ? `new-${Date.now()}` : asset.id };
    const next = suggestionsFor(copy);
    setStagedAsset(copy);
    setSelectedSuggestion(next[0].folderId);
    setAgentReady(false);
    setModal(null);
    setView("agent");
    window.setTimeout(() => setAgentReady(true), 900);
  }

  function handleFile(file: File) {
    const type: AssetType = file.type.startsWith("audio") ? "audio" : file.type.startsWith("image") ? "image" : "document";
    startAgent({
      id: `upload-${Date.now()}`,
      name: file.name,
      type,
      meta: `${Math.max(1, Math.round(file.size / 1024))} KB · Uploaded file`,
      added: "Just now",
      summary: "Notique extracted the title, available text, transcript cues and recent project context.",
    });
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
    if (stagedAsset && !inbox.some((item) => item.id === stagedAsset.id)) {
      setInbox((items) => [{ ...stagedAsset, folderId: undefined }, ...items]);
    }
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
    if (asset.folderId && folders.some((folder) => folder.id === asset.folderId)) setAssets((items) => [...items, asset]);
    else setInbox((items) => [...items, { ...asset, folderId: undefined }]);
    flash("Item restored");
  }

  function openRename(kind: "folder" | "asset", value: string, id: string) {
    setRenameKind(kind);
    setRenameValue(value);
    if (kind === "folder") setSelectedFolderId(id);
    else setSelectedAssetId(id);
    setMenuId(null);
    setShowRename(true);
    setModal("rename");
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
    setModal(null);
    flash("Name updated");
  }

  function deleteFolder() {
    const id = selectedFolderId;
    const moved = assets.filter((asset) => asset.folderId === id).map((asset) => ({ ...asset, folderId: undefined }));
    setAssets((items) => items.filter((asset) => asset.folderId !== id));
    setInbox((items) => [...moved, ...items]);
    setFolders((items) => items.filter((folder) => folder.id !== id));
    setModal(null);
    setView("projects");
    flash("Project deleted; its items were moved to Inbox");
  }

  function updateClaim(state: ClaimState, value?: string) {
    setClaimsByKind((current) => ({
      ...current,
      [projectKind]: current[projectKind].map((claim) => claim.id === selectedClaim.id
        ? { ...claim, state, proposed: value?.trim() || claim.proposed, editedReason: state === "edited" ? editReason.trim() || "Clarified by the project owner" : claim.editedReason }
        : claim),
    }));
    setEditMode(false);
    setEditReason("");
    flash(state === "confirmed" ? "Added to Current Understanding" : state === "edited" ? "Edited value and source history saved" : state === "rejected" ? "Not added; original extraction kept in history" : "Kept for later review");
  }

  function batchConfirmLowRisk() {
    setClaimsByKind((current) => ({
      ...current,
      [projectKind]: current[projectKind].map((claim) => claim.state === "pending" && claim.risk === "low" ? { ...claim, state: "confirmed" } : claim),
    }));
    flash("Low-risk updates confirmed");
  }

  function askAI() {
    if (!askText.trim()) return;
    const against = selectedClaim.againstQuote ? ` A conflicting statement is also recorded: “${selectedClaim.againstQuote}”` : " No conflicting evidence is currently attached.";
    setAskAnswer(`This suggestion is based on the transcript at ${selectedClaim.time}: “${selectedClaim.quote}”.${against}`);
  }

  function openTemplate(mode: string) {
    setTemplateMode(mode);
    setView("templates");
  }

  function Sidebar() {
    const projectArea = ["folder", "item", "workspace", "event", "review", "claim", "compare", "deliverables"].includes(view);
    return (
      <aside className="sidebar">
        <button className="logo" onClick={() => setView("projects")}><span>⌁</span>Notique AI</button>
        <button className="account account-button" onClick={() => setAccountOpen((open) => !open)}>
          <span className="avatar">A</span><span><strong>Aaron</strong><small>aaron@notiqueai.com</small></span><b>⌄</b>
        </button>
        {accountOpen && <div className="account-menu"><button onClick={() => { setAccountOpen(false); flash("Profile opened") }}>Profile</button><button onClick={() => { setAccountOpen(false); flash("Workspace settings opened") }}>Workspace settings</button></div>}
        <button className="search-button" onClick={() => setModal("search")}>⌕ <span>Search</span></button>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          <button className={view === "projects" || projectArea ? "nav-item active" : "nav-item"} onClick={() => setView("projects")}><span>▣</span>Projects<b>{folders.length}</b></button>
          <button className={view === "recordings" ? "nav-item active" : "nav-item"} onClick={() => setView("recordings")}><span>♪</span>Recordings<b>{allRecordings.length}</b></button>
          <button className={["inbox", "agent"].includes(view) ? "nav-item active" : "nav-item"} onClick={() => setView("inbox")}><span>▤</span>Inbox<b className={inbox.length ? "blue-count" : ""}>{inbox.length}</b></button>
          <button className={view === "trash" ? "nav-item active" : "nav-item"} onClick={() => setView("trash")}><span>♲</span>Trash<b>{trash.length}</b></button>
        </nav>
        <p className="nav-label resources">RESOURCES</p>
        <nav>
          <button className={view === "templates" && templateMode === "Explore" ? "nav-item active" : "nav-item"} onClick={() => openTemplate("Explore")}><span>◎</span><span>Explore Notique AI</span></button>
          <button className={view === "templates" && templateMode === "AI templates" ? "nav-item active" : "nav-item"} onClick={() => openTemplate("AI templates")}><span>▦</span><span>AI templates</span></button>
          <button className={view === "templates" && templateMode === "My templates" ? "nav-item active" : "nav-item"} onClick={() => openTemplate("My templates")}><span>▧</span><span>My templates</span></button>
        </nav>
        <div className="spacer" />
        <button className="upgrade" onClick={() => setModal("upgrade")}>Upgrade plan</button>
      </aside>
    );
  }

  function Toolbar({ title, count, action }: { title: string; count?: number; action?: "project" | "import" }) {
    return (
      <header className="toolbar">
        <h1>{title}{typeof count === "number" && <span> ({count})</span>}</h1>
        <div>
          <button className="sort" onClick={() => { setSortNewest((value) => !value); flash(sortNewest ? "Showing oldest first" : "Showing newest first") }}>{sortNewest ? "Newest first⌄" : "Oldest first⌃"}</button>
          {action === "project" && <button className="primary" onClick={() => setModal("newProject")}>New project</button>}
          {action === "import" && <button className="primary" onClick={() => setModal("import")}>Import</button>}
        </div>
      </header>
    );
  }

  function ProjectsView() {
    const ordered = sortNewest ? folders : [...folders].reverse();
    return (
      <div className="page">
        <Toolbar title="Projects" count={folders.length} action="project" />
        <div className="folder-grid">
          {ordered.map((folder) => (
            <article className="folder-card" key={folder.id} role="button" tabIndex={0} onClick={() => openFolder(folder.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openFolder(folder.id) }}>
              <span className={`folder-tab ${folder.color}`} />
              <button className="more" aria-label={`More options for ${folder.name}`} onClick={(event) => { event.stopPropagation(); setSelectedFolderId(folder.id); setMenuId(menuId === folder.id ? null : folder.id) }}>•••</button>
              <strong>{folder.name}</strong>
              <small>{folder.description}</small>
              <span className="folder-meta">{folderCounts[folder.id] || 0} items · {folder.updated}</span>
              {folder.id === "product" || folder.id === "oak" ? <span className="update-badge">{folder.kind === "contractor" ? 3 : 3} updates</span> : null}
              {menuId === folder.id && <span className="menu" onClick={(event) => event.stopPropagation()}><button onClick={() => openRename("folder", folder.name, folder.id)}>Rename</button><button className="danger" onClick={() => { setSelectedFolderId(folder.id); setModal("deleteFolder"); setMenuId(null) }}>Delete</button></span>}
            </article>
          ))}
        </div>
      </div>
    );
  }

  function RecordingsView() {
    const ordered = sortNewest ? allRecordings : [...allRecordings].reverse();
    return (
      <div className="page">
        <Toolbar title="Recordings" count={ordered.length} action="import" />
        <div className="recording-grid">
          {ordered.map((asset) => (
            <article className="recording-card" key={asset.id}>
              <button className="play" onClick={() => openItem(asset.id)}>▶</button>
              <button className="recording-copy" onClick={() => openItem(asset.id)}><strong>{asset.name}</strong><small>{folders.find((folder) => folder.id === asset.folderId)?.name}</small><b>{asset.meta}</b></button>
              <button className="more" onClick={() => setMenuId(menuId === asset.id ? null : asset.id)}>•••</button>
              {menuId === asset.id && <div className="menu card-menu"><button onClick={() => openRename("asset", asset.name, asset.id)}>Rename</button><button className="danger" onClick={() => moveToTrash(asset)}>Move to Trash</button></div>}
            </article>
          ))}
        </div>
      </div>
    );
  }

  function InboxView() {
    return (
      <div className="page">
        <Toolbar title="Inbox" count={inbox.length} action="import" />
        <div className="inbox-intro"><span className="sparkle">✦</span><span><strong>Let Notique file new content for you</strong><small>AI suggests two likely projects. Nothing moves until you allow it.</small></span><button className="secondary" onClick={() => setModal("import")}>Add something</button></div>
        {inbox.length ? <div className="content-table"><div className="table-head"><span>Name</span><span>Added</span><span>Status</span><span /></div>{inbox.map((asset) => <div className="table-row" key={asset.id}><button className="name-cell" onClick={() => openItem(asset.id)}><b className={`type-icon ${asset.type}`}>{typeIcon(asset.type)}</b><span><strong>{asset.name}</strong><small>{asset.meta}</small></span></button><span>{asset.added}</span><span className="unfiled">Not filed</span><button className="agent-button" onClick={() => startAgent(asset)}>File with AI</button></div>)}</div> : <div className="empty"><span>✓</span><h2>Inbox is clear</h2><p>New imports that need a project will appear here.</p><button className="primary" onClick={() => setModal("import")}>Import something</button></div>}
      </div>
    );
  }

  function TrashView() {
    return (
      <div className="page">
        <Toolbar title="Trash" count={trash.length} />
        {trash.length ? <div className="content-table"><div className="table-head"><span>Name</span><span>Deleted</span><span>Original project</span><span /></div>{trash.map((asset) => <div className="table-row" key={asset.id}><button className="name-cell" onClick={() => openItem(asset.id)}><b className={`type-icon ${asset.type}`}>{typeIcon(asset.type)}</b><span><strong>{asset.name}</strong><small>{asset.meta}</small></span></button><span>Just now</span><span>{folders.find((folder) => folder.id === asset.folderId)?.name || "Inbox"}</span><button className="secondary" onClick={() => restoreAsset(asset)}>Restore</button></div>)}</div> : <div className="empty"><span>♲</span><h2>Trash is empty</h2><p>Deleted items stay here for 30 days.</p><button className="secondary" onClick={() => setView("projects")}>Back to Projects</button></div>}
      </div>
    );
  }

  function FolderView() {
    const ordered = sortNewest ? folderAssets : [...folderAssets].reverse();
    return (
      <div className="page folder-page">
        <button className="back" onClick={() => setView("projects")}>‹ Projects</button>
        <header className="folder-header"><div><h1>{selectedFolder.name}</h1><p>{selectedFolder.description}</p></div><div><button className="secondary" onClick={() => openRename("folder", selectedFolder.name, selectedFolder.id)}>Rename</button><button className="primary" onClick={() => setModal("import")}>Add</button></div></header>
        <button className="workspace-entry" onClick={() => openWorkspace()}><span className="workspace-entry-icon">✦</span><span><strong>Open AI workspace</strong><small>Review {selectedFolder.kind === "contractor" ? 3 : 3} updates, compare events and create deliverables</small></span><b>Open ›</b></button>
        <div className="folder-summary"><span><strong>{folderAssets.length}</strong><small>Items</small></span><span><strong>{folderAssets.filter((item) => item.type === "audio").length}</strong><small>Recordings</small></span><span><strong>{folderAssets.filter((item) => item.type !== "audio").length}</strong><small>Files and notes</small></span></div>
        <div className="content-table folder-table"><div className="table-head"><span>Name</span><span>Type</span><span>Added</span><span /></div>{ordered.map((asset) => <div className={asset.id === lastFiledId ? "table-row newly-filed" : "table-row"} key={asset.id}><button className="name-cell" onClick={() => openItem(asset.id)}><b className={`type-icon ${asset.type}`}>{typeIcon(asset.type)}</b><span><strong>{asset.name}</strong><small>{asset.summary}</small></span></button><span className="type-label">{asset.type}</span><span>{asset.added}</span><div className="row-actions">{asset.id === lastFiledId && <span className="filed-badge">Filed by AI</span>}<button className="more inline" onClick={() => setMenuId(menuId === asset.id ? null : asset.id)}>•••</button>{menuId === asset.id && <div className="menu card-menu"><button onClick={() => openRename("asset", asset.name, asset.id)}>Rename</button><button className="danger" onClick={() => moveToTrash(asset)}>Move to Trash</button></div>}</div></div>)}</div>
      </div>
    );
  }

  function AgentView() {
    const selected = suggestions.find((suggestion) => suggestion.folderId === selectedSuggestion) || suggestions[0];
    return (
      <div className="agent-page">
        <button className="back" onClick={keepInInbox}>‹ Back to Inbox</button>
        <div className="agent-title"><span className="agent-mark">✦</span><div><h1>Where should this go?</h1><p>Notique checks the item and your recent project activity. You make the final choice.</p></div></div>
        {stagedAsset && <article className="asset-preview"><b className={`type-icon large ${stagedAsset.type}`}>{typeIcon(stagedAsset.type)}</b><span><strong>{stagedAsset.name}</strong><small>{stagedAsset.meta}</small></span><button onClick={() => { setSelectedAssetId(stagedAsset.id); setModal("transcript") }}>Preview</button></article>}
        {!agentReady ? <section className="analyzing"><span className="spinner" /><h2>Finding the best project</h2><p>Reading the title, available content and recent project context.</p></section> : <><section className="suggestion-section"><header><div><h2>Two likely projects</h2><p>Select one, then allow Notique to file the item.</p></div><span>AI suggestion</span></header><div className="suggestions">{suggestions.map((suggestion, index) => { const folder = folders.find((item) => item.id === suggestion.folderId)!; const active = selectedSuggestion === suggestion.folderId; return <button className={active ? "suggestion active" : "suggestion"} key={suggestion.folderId} onClick={() => setSelectedSuggestion(suggestion.folderId)}><span className="radio">{active ? "●" : ""}</span><span className={`mini-folder ${folder.color}`}>▰</span><span className="suggestion-copy"><span><b>{index === 0 ? "BEST MATCH" : "ALSO POSSIBLE"}</b><em>{suggestion.confidence}% match</em></span><strong>{folder.name}</strong><small>{folder.description}</small><ul>{suggestion.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></span></button> })}</div></section><section className="agent-confirm"><span><strong>File in {folders.find((folder) => folder.id === selected?.folderId)?.name}</strong><small>You can move or rename it later.</small></span><button className="text-button" onClick={keepInInbox}>Keep in Inbox</button><button className="primary allow" onClick={allowFiling}>Allow and file</button></section></>}
      </div>
    );
  }

  function ItemView() {
    const parent = folders.find((folder) => folder.id === selectedAsset.folderId);
    return (
      <div className="page item-page">
        <button className="back" onClick={() => parent ? openFolder(parent.id) : setView(selectedAsset.folderId ? "folder" : "inbox")}>‹ {parent?.name || "Inbox"}</button>
        <header className="item-header"><span className={`type-icon hero ${selectedAsset.type}`}>{typeIcon(selectedAsset.type)}</span><div><h1>{selectedAsset.name}</h1><p>{selectedAsset.meta} · {selectedAsset.added}</p></div><button className="secondary" onClick={() => openRename("asset", selectedAsset.name, selectedAsset.id)}>Rename</button></header>
        <div className="item-layout"><article className="item-main"><h2>Summary</h2><p>{selectedAsset.summary}</p>{selectedAsset.type === "audio" && <><h2>Transcript preview</h2><blockquote>“The project view matters because the details build up over more than one conversation. I still want to approve where things go.”</blockquote><button className="secondary" onClick={() => setModal("transcript")}>Open full transcript</button></>}{selectedAsset.type === "image" && <button className="evidence-image-button" onClick={() => setModal("evidence")}><span className="photo-placeholder">PHOTO</span><span><strong>Open image evidence</strong><small>Captured with time and project metadata</small></span></button>}</article><aside><h3>Project</h3><button onClick={() => parent ? openFolder(parent.id) : startAgent(selectedAsset)}><span className={`mini-folder ${parent?.color || "slate"}`}>▰</span><span><strong>{parent?.name || "Not filed"}</strong><small>{parent ? "Filed in this project" : "Choose with AI"}</small></span></button><h3>Details</h3><p>Type <b>{selectedAsset.type}</b></p><p>Added <b>{selectedAsset.added}</b></p><button className="detail-action" onClick={() => moveToTrash(selectedAsset)}>Move to Trash</button></aside></div>
      </div>
    );
  }

  function ProjectHeader({ active = "overview" }: { active?: "overview" | "events" | "compare" | "deliverables" }) {
    return (
      <>
        <button className="back-button" onClick={() => openFolder(selectedFolder.id)}>‹ {selectedFolder.name}</button>
        <div className="project-header"><div><h1>{profile.title}</h1><p>{profile.meta}</p></div><div><button className="secondary" onClick={() => setModal("share")}>Share</button><button className="primary" onClick={() => setModal("import")}>Add</button><button className="icon-button" onClick={() => setMenuId(menuId === "project-more" ? null : "project-more")}>•••</button>{menuId === "project-more" && <div className="menu project-menu"><button onClick={() => openRename("folder", selectedFolder.name, selectedFolder.id)}>Rename project</button><button onClick={() => { setMenuId(null); setModal("deleteFolder") }} className="danger">Delete project</button></div>}</div></div>
        <div className="tabs"><button className={active === "overview" ? "active" : ""} onClick={() => setView("workspace")}>Overview</button><button className={active === "events" ? "active" : ""} onClick={() => setView("event")}>Events <span>4</span></button><button className={active === "compare" ? "active" : ""} onClick={() => setView("compare")}>Compare events</button><button className={active === "deliverables" ? "active" : ""} onClick={() => setView("deliverables")}>Deliverables <span>3</span></button></div>
      </>
    );
  }

  function WorkspaceView() {
    return (
      <div className="product-page">
        <ProjectHeader />
        {pendingCount > 0 ? <section className="review-notice"><span className="notice-icon">✦</span><span><strong>{pendingCount} updates need your review</strong><small>Only changes, conflicts and higher-risk information are shown here.</small></span><button className="primary" onClick={() => setView("review")}>Review updates</button></section> : <section className="review-notice complete"><span className="notice-icon">✓</span><span><strong>Current Understanding is up to date</strong><small>All recent changes have been reviewed.</small></span><button className="secondary" onClick={() => setView("deliverables")}>Open deliverables</button></section>}
        <div className="project-columns"><section className="project-main"><div className="section-title"><h2>Current Understanding</h2><span>Updated from four events</span></div><div className="summary-grid">{overview.map((item, index) => <article className={index === 0 ? "summary-card wide" : "summary-card"} key={item.label}><small>{item.label}</small><strong>{item.value}</strong>{item.claimId && <button onClick={() => openClaim(item.claimId!)}>{claims.find((claim) => claim.id === item.claimId)?.state === "pending" ? "Review evidence" : "View source"}</button>}</article>)}</div><div className="section-title"><h2>Recent events</h2><button onClick={() => setView("event")}>View latest</button></div><div className="activity-list"><button onClick={() => setView("event")}><span className="activity-icon">♪</span><span><strong>{profile.event}</strong><small>{profile.eventMeta}</small></span><Status state={pendingCount ? "pending" : "confirmed"} /><b>›</b></button><button onClick={() => setView("compare")}><span className="activity-icon">▤</span><span><strong>{projectKind === "contractor" ? "Scope Follow-up Call" : "Research Debrief"}</strong><small>Previous event · compared with latest</small></span><Status state="confirmed" /><b>›</b></button><button onClick={() => setView("compare")}><span className="activity-icon">♪</span><span><strong>{projectKind === "contractor" ? "Site Walkthrough 01" : "Customer Interview · Round 2"}</strong><small>Original project context</small></span><Status state="confirmed" /><b>›</b></button></div></section><aside className="project-aside"><section className="side-card"><h3>Project files</h3>{folderAssets.slice(0, 2).map((asset) => <button key={asset.id} onClick={() => openItem(asset.id)}><span>{typeIcon(asset.type)}</span><span><strong>{asset.name}</strong><small>{asset.meta}</small></span></button>)}<button className="plain-link" onClick={() => openFolder(selectedFolder.id)}>View all files</button></section><section className="side-card"><h3>People</h3><button className="person-button" onClick={() => flash("Aaron Wen · Project owner")}><span className="avatar">A</span><span><strong>Aaron Wen</strong><small>Owner</small></span></button><button className="person-button" onClick={() => flash(projectKind === "contractor" ? "Maria · Change Order owner" : "Kevin · Design collaborator")}><span className="avatar purple">{projectKind === "contractor" ? "M" : "K"}</span><span><strong>{projectKind === "contractor" ? "Maria" : "Kevin"}</strong><small>Collaborator</small></span></button></section><section className="side-card"><h3>Deliverables</h3><p>{projectKind === "contractor" ? "Change Order, Scope Checklist and Site Report" : "Project Brief, Action Checklist and Decision Log"}</p><button className="secondary wide-button" onClick={() => setView("deliverables")}>Open deliverables</button></section></aside></div>
      </div>
    );
  }

  function EventView() {
    return (
      <div className="product-page">
        <ProjectHeader active="events" />
        <div className="event-header"><div><button className="back-button" onClick={() => setView("workspace")}>‹ Overview</button><h2>{profile.event}</h2><p>{profile.eventMeta}</p></div><div><button className="secondary" onClick={() => setModal("transcript")}>Open transcript</button><button className="primary" onClick={() => setView("review")}>Review {pendingCount} updates</button></div></div>
        <div className="event-stats"><span><strong>{projectKind === "contractor" ? "24:18" : "31:08"}</strong><small>Duration</small></span><span><strong>{projectKind === "contractor" ? 3 : 2}</strong><small>People</small></span><span><strong>{projectKind === "contractor" ? 3 : 2}</strong><small>Files</small></span><span><strong>{pendingCount}</strong><small>Updates</small></span></div>
        <div className="event-layout"><section className="event-content"><h2>Context Page</h2><article className="note-card"><h3>{projectKind === "contractor" ? "Walkthrough result" : "Interview result"}</h3><p>{projectKind === "contractor" ? "The latest walkthrough changed the working price, introduced a conflict around electrical scope and made the signed Change Order a start condition. Photos are attached directly to the related scope and evidence requirements." : "The customer described work that spans several meetings and asked for a source-linked Project Brief. The conversation also produced a test plan, a broader user definition and clear ownership for the next prototype."}</p></article><h2>Claims from this event</h2><div className="update-list">{claims.map((claim) => <button key={claim.id} onClick={() => openClaim(claim.id)}><span><small>{claim.category} · {claim.field}</small><strong>{claim.proposed}</strong></span><Status state={claim.state} /><b>›</b></button>)}</div></section><aside className="event-sources"><h2>Sources</h2><button onClick={() => setModal("transcript")}><span className="source-icon">♪</span><span><strong>Recording and transcript</strong><small>Timestamped · full context available</small></span></button>{folderAssets.filter((asset) => asset.type !== "audio").slice(0, 2).map((asset) => <button key={asset.id} onClick={() => openItem(asset.id)}><span className="source-icon">{typeIcon(asset.type)}</span><span><strong>{asset.name}</strong><small>{asset.meta}</small></span></button>)}{projectKind === "contractor" && <button className="context-photo" onClick={() => setModal("evidence")}><img src="/evidence-room-capture.jpg" alt="Site wall evidence" /><span>Open site photo evidence</span></button>}</aside></div>
      </div>
    );
  }

  function ReviewView() {
    const visible = claims.filter((claim) => reviewFilter === "all" || (reviewFilter === "pending" ? claim.state === "pending" : claim.state !== "pending"));
    return (
      <div className="product-page narrow-page">
        <button className="back-button" onClick={() => setView("workspace")}>‹ {profile.title}</button>
        <div className="review-header"><div><h1>Review Queue</h1><p>Only information that needs professional judgment appears here.</p></div><span>{pendingCount} remaining</span></div>
        <div className="review-tools"><div className="review-filters"><button className={reviewFilter === "pending" ? "active" : ""} onClick={() => setReviewFilter("pending")}>Needs review</button><button className={reviewFilter === "reviewed" ? "active" : ""} onClick={() => setReviewFilter("reviewed")}>Reviewed</button><button className={reviewFilter === "all" ? "active" : ""} onClick={() => setReviewFilter("all")}>All updates</button></div><button className="secondary" onClick={batchConfirmLowRisk}>Confirm low-risk updates</button></div>
        {visible.length ? <div className="review-list">{visible.map((claim) => <button key={claim.id} onClick={() => openClaim(claim.id)}><div><span className={`risk risk-${claim.risk}`}>{claim.risk} risk</span><small>{claim.category} · {claim.field}</small><h2>{claim.proposed}</h2><p>{claim.reason}</p></div><div className="review-change"><span><small>Previous</small>{claim.previous}</span><b>›</b><span><small>Latest</small>{claim.proposed}</span></div><span className="review-link">Review evidence ›</span></button>)}</div> : <div className="empty-review"><span>✓</span><h2>Nothing in this view</h2><p>Choose another filter or return to the project.</p><button className="primary" onClick={() => setView("workspace")}>Return to project</button></div>}
      </div>
    );
  }

  function ClaimView() {
    const original = claimSeeds[projectKind].find((claim) => claim.id === selectedClaim.id)?.proposed || selectedClaim.proposed;
    return (
      <div className="product-page narrow-page">
        <button className="back-button" onClick={() => setView("review")}>‹ Review Queue</button>
        <div className="claim-header"><div><small>{selectedClaim.category} · {selectedClaim.field}</small><h1>{selectedClaim.proposed}</h1><p>{selectedClaim.reason}</p></div><Status state={selectedClaim.state} /></div>
        <div className="claim-layout"><section className="evidence-column"><h2>Supporting evidence</h2><article className="transcript-evidence"><div><span className="avatar">C</span><span><strong>{projectKind === "contractor" ? "Contractor" : "Customer"}</strong><small>{profile.event}</small></span><button onClick={() => setModal("transcript")}>{selectedClaim.time} ▶</button></div><blockquote>“{selectedClaim.quote}”</blockquote><p>Transcript · open to see the surrounding conversation</p></article>{projectKind === "contractor" && <button className="file-evidence clickable-evidence" onClick={() => setModal("evidence")}><img src="/evidence-room-capture.jpg" alt="Site evidence" /><span><strong>Site photo 03</strong><small>Jul 25 · kitchen wall and outlet</small></span></button>}{selectedClaim.againstQuote && <><h2>Conflicting evidence</h2><article className="transcript-evidence conflict-evidence"><div><span className="avatar purple">C</span><span><strong>Client</strong><small>Scope Follow-up Call · Jul 23</small></span><button onClick={() => setModal("transcript")}>08:42 ▶</button></div><blockquote>“{selectedClaim.againstQuote}”</blockquote><p>The system keeps both statements instead of choosing one.</p></article></>}<h2>Project history</h2><button className="history-card clickable-history" onClick={() => setView("compare")}><small>Previous value</small><strong>{selectedClaim.previous}</strong><p>Open the event comparison and original evidence.</p></button>{selectedClaim.state === "edited" && <article className="audit-card"><small>AI original extraction</small><strong>{original}</strong><small>User final wording</small><strong>{selectedClaim.proposed}</strong><p>Reason: {selectedClaim.editedReason}</p></article>}</section><aside className="decision-card"><h2>Review this update</h2><div className="value-comparison"><span><small>Previous</small>{selectedClaim.previous}</span><span><small>Suggested</small>{selectedClaim.proposed}</span></div>{editMode ? <div className="edit-panel"><label htmlFor="edit-value">Final wording</label><textarea id="edit-value" value={editText} onChange={(event) => setEditText(event.target.value)} /><label htmlFor="edit-reason">Reason for the change</label><input id="edit-reason" value={editReason} onChange={(event) => setEditReason(event.target.value)} placeholder="What did you correct?" /><div><button className="secondary" onClick={() => setEditMode(false)}>Cancel</button><button className="primary" onClick={() => updateClaim("edited", editText)}>Save edit</button></div></div> : <div className="decision-actions"><button className="primary wide-button" onClick={() => updateClaim("confirmed")}>Confirm and add</button><button className="secondary wide-button" onClick={() => { setEditText(selectedClaim.proposed); setEditMode(true) }}>Edit before adding</button><button className="text-action" onClick={() => updateClaim("rejected")}>Do not add</button><button className="text-action" onClick={() => updateClaim("pending")}>Keep for later</button></div>}<p className="decision-note">This updates Current Understanding and connected deliverables. Original evidence remains unchanged.</p><button className="ask-toggle" onClick={() => setAskOpen((open) => !open)}>Ask AI about this claim</button>{askOpen && <div className="ask-panel"><textarea value={askText} onChange={(event) => setAskText(event.target.value)} placeholder="Why do you think this is true?" /><button className="primary" onClick={askAI}>Ask</button>{askAnswer && <p>{askAnswer}</p>}</div>}</aside></div>
      </div>
    );
  }

  function CompareView() {
    return (
      <div className="product-page">
        <ProjectHeader active="compare" />
        <div className="section-title page-section-title"><div><h2>Compare events</h2><p>Changes are grouped by the same project fact, so you do not need to compare two summaries.</p></div><button className="secondary" onClick={() => setModal("transcript")}>Open source events</button></div>
        <div className="compare-banner"><span>Original event<br /><strong>{projectKind === "contractor" ? "Site Walkthrough 01 · Jul 18" : "Customer Interview · Round 2 · Jul 24"}</strong></span><b>compared with</b><span>Latest event<br /><strong>{profile.event} · {projectKind === "contractor" ? "Jul 25" : "Jul 31"}</strong></span></div>
        <div className="history-table"><div className="history-head"><span>Field</span><span>Original record</span><span>Latest record</span><span>Result</span></div>{claims.map((claim) => <button key={claim.id} onClick={() => openClaim(claim.id)}><strong>{claim.field}</strong><span>{claim.previous}</span><span>{claim.proposed}</span><span className="latest-cell">{claim.state === "pending" ? "Needs review" : claim.state === "rejected" ? "Not added" : "Current value"}</span></button>)}</div>
      </div>
    );
  }

  function DeliverablesView() {
    const titles = projectKind === "contractor" ? ["Change Order", "Scope Checklist", "Site Report"] : ["Project Brief", "Action Checklist", "Decision Log"];
    const isChecklist = activeDeliverable === 1;
    return (
      <div className="product-page">
        <ProjectHeader active="deliverables" />
        <div className="deliverable-header"><div><h2>Deliverables</h2><p>Create client-ready or team-ready work from reviewed project information.</p></div><button className="primary" onClick={() => setModal("newDeliverable")}>New deliverable</button></div>
        {pendingCount > 0 && <div className="deliverable-warning"><span>!</span><p><strong>{pendingCount} updates are not included yet.</strong> Review them before sending a final document.</p><button onClick={() => setView("review")}>Review now</button></div>}
        <div className="deliverable-layout"><aside>{titles.map((title, index) => <button className={activeDeliverable === index ? "active" : ""} key={title} onClick={() => setActiveDeliverable(index)}><span className="file-icon">{index === 1 ? "✓" : "▤"}</span><span><strong>{title}</strong><small>{savedDeliverables.includes(index) ? "Saved to project" : index === 1 ? "Working checklist" : "Draft ready"}</small></span><b>›</b></button>)}</aside><section className="document-preview"><div className="document-bar"><span><small>{savedDeliverables.includes(activeDeliverable) ? "SAVED" : "DRAFT"}</small><strong>{titles[activeDeliverable]}</strong></span><span><button className="secondary" onClick={() => { window.print(); flash("Print dialog opened for PDF export") }}>Export PDF</button><button className="primary" onClick={() => { setSavedDeliverables((items) => items.includes(activeDeliverable) ? items : [...items, activeDeliverable]); flash("Deliverable saved to the project") }}>{savedDeliverables.includes(activeDeliverable) ? "Saved ✓" : "Save to project"}</button></span></div>{isChecklist ? <article className="document-sheet checklist-sheet"><div className="doc-brand">⌁ Notique AI</div><small>{profile.title.toUpperCase()}</small><h1>{titles[activeDeliverable]}</h1><p className="doc-intro">Generated from confirmed project information. Each item can require a person, evidence or approval.</p><div className="check-progress"><strong>{Object.values(checklistDone).filter(Boolean).length}/{checklist.length} complete</strong><span><i style={{ width: `${Object.values(checklistDone).filter(Boolean).length / checklist.length * 100}%` }} /></span></div><h2>Checklist</h2>{checklist.map((item, index) => <div className="smart-check-row" key={item}><button className={checklistDone[index] ? "check-toggle checked" : "check-toggle"} onClick={() => setChecklistDone((current) => ({ ...current, [index]: !current[index] }))}>{checklistDone[index] ? "✓" : ""}</button><span><strong>{item}</strong><small>{index === 0 ? "Owner: Aaron · approval required" : index === checklist.length - 1 ? "Evidence required" : "Owner: Unassigned"}</small></span>{checklistEvidence[index] && <em>Photo attached</em>}<button className="row-source" onClick={() => openClaim(claims[Math.min(index, claims.length - 1)].id)}>Source</button><button className="row-photo" onClick={() => { setEvidenceTask(index); setModal("evidence") }}>＋ Evidence</button></div>)}</article> : <article className="document-sheet"><div className="doc-brand">⌁ Notique AI</div><small>{profile.title.toUpperCase()}</small><h1>{titles[activeDeliverable]}</h1><p className="doc-intro">Prepared from reviewed project information. Key statements stay linked to their sources.</p><div className="doc-meta"><span><small>Owner</small>Aaron Wen</span><span><small>Updated</small>Today</span><span><small>Status</small>{pendingCount ? `${pendingCount} updates pending` : "Ready"}</span></div><h2>{projectKind === "contractor" ? "Scope and changes" : "Current decisions"}</h2>{claims.filter((claim) => claim.state !== "rejected").slice(0, 4).map((claim) => <div className="deliverable-claim" key={claim.id}><span><strong>{claim.field}</strong><small>{claim.state === "pending" ? "Pending review · excluded from final export" : claim.proposed}</small></span><button onClick={() => openClaim(claim.id)}>View source</button></div>)}</article>}</section></div>
      </div>
    );
  }

  function TemplatesView() {
    const cards = [
      { name: "Project Brief", text: "Decisions, open questions and evidence from several events", icon: "▤" },
      { name: "Action Checklist", text: "Confirmed commitments turned into assigned, evidence-ready tasks", icon: "✓" },
      { name: "Change Order", text: "Scope, price, approvals and linked site evidence", icon: "$" },
      { name: "Buyer Journey", text: "Preferences and decisions accumulated across showings", icon: "⌂" },
      { name: "Claim Assessment", text: "Damage, cause, customer statement and photo evidence", icon: "◈" },
      { name: "Decision Log", text: "A source-linked record of how project decisions changed", icon: "≋" },
    ];
    return (
      <div className="page templates-page"><Toolbar title={templateMode} count={cards.length} /><div className="template-hero"><span>✦</span><div><h2>Start from a deliverable, then connect it to a Project</h2><p>Templates use the same recordings, photos, files and reviewed claims already in Notique.</p></div></div><div className="template-grid">{cards.map((card, index) => <button key={card.name} onClick={() => { setSelectedFolderId(index === 2 ? "oak" : "product"); setProjectKind(index === 2 ? "contractor" : "general"); setActiveDeliverable(index === 1 ? 1 : index === 2 ? 0 : 0); setView("deliverables") }}><span>{card.icon}</span><strong>{card.name}</strong><small>{card.text}</small><b>Use template ›</b></button>)}</div></div>
    );
  }

  function Content() {
    if (view === "projects") return <ProjectsView />;
    if (view === "recordings") return <RecordingsView />;
    if (view === "inbox") return <InboxView />;
    if (view === "trash") return <TrashView />;
    if (view === "folder") return <FolderView />;
    if (view === "agent") return <AgentView />;
    if (view === "item") return <ItemView />;
    if (view === "workspace") return <WorkspaceView />;
    if (view === "event") return <EventView />;
    if (view === "review") return <ReviewView />;
    if (view === "claim") return <ClaimView />;
    if (view === "compare") return <CompareView />;
    if (view === "deliverables") return <DeliverablesView />;
    return <TemplatesView />;
  }

  const searchResults = folders.filter((folder) => folder.name.toLowerCase().includes(renameValue.toLowerCase()));

  return (
    <div className="app-shell">
      <Sidebar />
      <header className="mobile-header"><button onClick={() => setView("projects")}>⌁ Notique AI</button><button onClick={() => setModal("import")}>＋</button></header>
      <main><Content /></main>
      <nav className="mobile-nav"><button onClick={() => setView("projects")}>▣<small>Projects</small></button><button onClick={() => setView("recordings")}>♪<small>Recordings</small></button><button onClick={() => setView("inbox")}>▤<small>Inbox</small></button><button onClick={() => setModal("import")}>＋<small>Import</small></button></nav>

      {modal === "import" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal import-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>Add to Notique</h2><p>Drop in a recording, photo or document.</p></div><button onClick={() => setModal(null)}>×</button></header><label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) handleFile(file) }}><input type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) handleFile(file) }} /><span className="upload-icon">↥</span><strong>Drop a file here</strong><small>or click to choose from your computer</small></label><p className="sample-label">TRY THE COMPLETE FLOW</p><div className="sample-list">{samples.map((sample) => <button key={sample.id} onClick={() => startAgent(sample)}><b className={`type-icon ${sample.type}`}>{typeIcon(sample.type)}</b><span><strong>{sample.name}</strong><small>{sample.meta}</small></span><em>Use sample</em></button>)}</div></section></div>}

      {modal === "newProject" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal small-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>New project</h2><p>Keep related recordings, files and notes together.</p></div><button onClick={() => setModal(null)}>×</button></header><label>Project name</label><input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Untitled project" /><div className="modal-actions"><button className="secondary" onClick={() => setModal(null)}>Cancel</button><button className="primary" onClick={() => { const name = newProjectName.trim(); if (!name) return; const id = `folder-${Date.now()}`; setFolders((items) => [...items, { id, name, description: "Recordings, files and notes", color: "slate", updated: "Just now", kind: "general" }]); setSelectedFolderId(id); setNewProjectName(""); setModal(null); setView("folder"); flash("Project created") }}>Create project</button></div></section></div>}

      {modal === "rename" && showRename && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal small-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>Rename {renameKind}</h2></div><button onClick={() => setModal(null)}>×</button></header><label>Name</label><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} /><div className="modal-actions"><button className="secondary" onClick={() => setModal(null)}>Cancel</button><button className="primary" onClick={saveRename}>Save</button></div></section></div>}

      {modal === "search" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal search-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>Search Notique</h2><p>Find projects, recordings and files.</p></div><button onClick={() => setModal(null)}>×</button></header><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} placeholder="Search projects" /><div className="search-results">{searchResults.map((folder) => <button key={folder.id} onClick={() => { setModal(null); openFolder(folder.id) }}><span className={`mini-folder ${folder.color}`}>▰</span><span><strong>{folder.name}</strong><small>{folder.description}</small></span><b>›</b></button>)}</div></section></div>}

      {modal === "transcript" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal transcript-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>{stagedAsset?.name || profile.event}</h2><p>Transcript with original timestamps</p></div><button onClick={() => setModal(null)}>×</button></header><div className="transcript-body"><button onClick={() => flash("Audio jumped to 12:18")}><b>12:18</b><span><strong>Customer</strong><p>The project view is useful because my decisions are spread across several conversations.</p></span></button><button onClick={() => flash(`Audio jumped to ${selectedClaim.time}`)}><b>{selectedClaim.time}</b><span><strong>{projectKind === "contractor" ? "Contractor" : "Customer"}</strong><p>{selectedClaim.quote}</p></span></button>{selectedClaim.againstQuote && <button onClick={() => flash("Audio jumped to 08:42")}><b>08:42</b><span><strong>Client</strong><p>{selectedClaim.againstQuote}</p></span></button>}</div><div className="modal-actions"><button className="secondary" onClick={() => setModal(null)}>Close</button><button className="primary" onClick={() => { setModal(null); flash("Playing from selected evidence") }}>Play recording</button></div></section></div>}

      {modal === "share" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal small-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>Share project</h2><p>Anyone with the link can view the latest reviewed version.</p></div><button onClick={() => setModal(null)}>×</button></header><label>Share link</label><input readOnly value={`notique.local/project/${selectedFolder.id}`} /><div className="modal-actions"><button className="secondary" onClick={() => setModal(null)}>Cancel</button><button className="primary" onClick={() => { navigator.clipboard?.writeText(`http://localhost:3000/project/${selectedFolder.id}`); setModal(null); flash("Share link copied") }}>Copy link</button></div></section></div>}

      {modal === "newDeliverable" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>New deliverable</h2><p>Choose what this project should produce.</p></div><button onClick={() => setModal(null)}>×</button></header><div className="new-deliverable-list"><button onClick={() => { setActiveDeliverable(0); setModal(null) }}><span>▤</span><strong>{projectKind === "contractor" ? "Change Order" : "Project Brief"}</strong><small>Document with source-linked project facts</small></button><button onClick={() => { setActiveDeliverable(1); setModal(null) }}><span>✓</span><strong>{projectKind === "contractor" ? "Scope Checklist" : "Action Checklist"}</strong><small>Executable fields, owners and evidence requirements</small></button><button onClick={() => { setActiveDeliverable(2); setModal(null) }}><span>≋</span><strong>{projectKind === "contractor" ? "Site Report" : "Decision Log"}</strong><small>A durable record of reviewed project changes</small></button></div></section></div>}

      {modal === "upgrade" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal small-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>Notique Pro</h2><p>Unlimited projects, advanced deliverables and team review.</p></div><button onClick={() => setModal(null)}>×</button></header><div className="plan-card"><strong>$19</strong><small>per member / month</small><p>Everything in this product mock is available in the Pro workspace.</p></div><div className="modal-actions"><button className="secondary" onClick={() => setModal(null)}>Not now</button><button className="primary" onClick={() => { setModal(null); flash("Upgrade checkout opened") }}>Continue</button></div></section></div>}

      {modal === "deleteFolder" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal small-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>Delete {selectedFolder.name}?</h2><p>Its files will move to Inbox so nothing is lost.</p></div><button onClick={() => setModal(null)}>×</button></header><div className="modal-actions"><button className="secondary" onClick={() => setModal(null)}>Cancel</button><button className="primary destructive" onClick={deleteFolder}>Delete project</button></div></section></div>}

      {modal === "evidence" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal evidence-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>{view === "deliverables" ? "Add checklist evidence" : "Photo evidence"}</h2><p>Evidence stays connected to its original event and project.</p></div><button onClick={() => setModal(null)}>×</button></header><img src="/evidence-room-capture.jpg" alt="Room and site evidence" /><div className="evidence-meta"><span><small>Captured</small>Jul 25, 7:36 PM</span><span><small>Event</small>{profile.event}</span><span><small>Project</small>{profile.title}</span></div><div className="modal-actions"><button className="secondary" onClick={() => setModal(null)}>Close</button>{view === "deliverables" && <button className="primary" onClick={() => { setChecklistEvidence((current) => ({ ...current, [evidenceTask]: true })); setModal(null); flash("Evidence attached to checklist item") }}>Attach evidence</button>}</div></section></div>}

      {toast && <div className="toast">✓ {toast}</div>}
    </div>
  );
}
