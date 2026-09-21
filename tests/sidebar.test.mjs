import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 侧栏像 ChatGPT / Claude 那样按文件夹列出项目。这里守的是三件事：分组的
 * 依据、点一项打开的是工作区、收起后列表整个不在。
 */
test("the sidebar lists projects grouped by folder and opens the workspace on click", async () => {
  const page = await readFile(path.join(root, "app/page.tsx"), "utf8");
  const aside = page.slice(page.indexOf('aria-label="应用侧栏"'), page.indexOf('className="mobile-header"'));

  // 导航只有首页和项目管理；以前那个显示当前项目名的按钮由列表取代。
  assert.match(aside, /aria-label="首页"/);
  assert.match(aside, /aria-label="项目管理"/);
  assert.doesNotMatch(aside, /aria-label=\{project\.name\}/);

  // 分组依据是 folderName，没有文件夹的项目和项目管理页一样叫默认文件夹。
  const grouping = page.slice(page.indexOf("const sidebarFolders = useMemo"), page.indexOf("}, [projects]);"));
  assert.match(grouping, /item\.folderName/);
  assert.match(grouping, /"默认文件夹"/);
  assert.match(grouping, /sortProjects\(projects/);

  // 点一项走的是和「当前项目」下拉同一条路：进工作区并加载该项目。
  const list = aside.slice(aside.indexOf('className="sidebar-projects"'));
  assert.match(list, /setSimpleFlow\(true\); void loadSimpleProject\(item\.id\)/);
  assert.match(list, /replace\(\/\^\\\[SYNTHETIC\\\]\\s\*\/, ""\)/);
  assert.match(list, /pending > 0 && <span className="sidebar-project-badge"/);
  assert.match(list, /projectsState === "loading"[^\n]*正在读取…/);

  // 收起时列表整个不渲染，只剩图标导航。
  assert.match(aside, /\{!sidebarCollapsed && [^\n]*\(\n\s*<nav className="sidebar-projects"/);
});

test("the sidebar project list scrolls on its own and is hidden on icon-only sidebars", async () => {
  const css = await readFile(path.join(root, "app/globals.css"), "utf8");
  assert.match(css, /^\.sidebar-projects \{[^\n]*min-height: 0;[^\n]*overflow-y: auto;/m);
  assert.match(css, /\.sidebar-collapsed \.sidebar-projects \{ display: none; \}/);
  // 801 到 980px 之间侧栏不靠 .sidebar-collapsed 也是图标条，列表同样得藏起来。
  assert.match(css, /@media \(max-width: 980px\)[\s\S]*?\.sidebar-projects \{ display: none; \}/);
});
