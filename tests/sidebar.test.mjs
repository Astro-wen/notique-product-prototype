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

test("侧栏每个项目自带垃圾桶，删的是它自己不是当前项目", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  // 按钮不能嵌套，所以项目名和垃圾桶是并排两个按钮，整行共用 hover 高亮。
  assert.match(page, /className="sidebar-project-row"/);
  assert.match(page, /className="sidebar-project-delete"/);
  assert.match(page, /openProjectDeletePreview\(item\)/);
  // 读屏要听得出删的是哪一个，光说「移到回收站」分不清是哪一行。
  assert.match(page, /aria-label=\{`把 \$\{name\} 移到回收站`\}/);
});

test("删掉别的项目不会把人从当前项目里弹走", async () => {
  const { declarationSource } = await import("./helpers/ui-source.mjs");
  const move = declarationSource("moveProjectToTrash");
  assert.match(move, /const wasCurrent = project\?\.id === deleting\.id;/);
  // 删的不是当前项目就到此为止：人还在它里面干活。
  assert.match(move, /if \(!wasCurrent\) return;/);
});

test("侧栏的项目列表不吃主导航那套通用按钮样式", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  // 项目列表也是一个 nav。不排除的话 width:100% 会把垃圾桶撑成整行，
  // 项目名被挤成 0 宽，整个列表看起来是空的。
  assert.match(css, /\.sidebar nav:not\(\.sidebar-projects\) button \{/);
  assert.match(css, /\.sidebar nav:not\(\.sidebar-projects\) \{ display: grid/);
  assert.match(css, /\.interface-refresh \.sidebar nav:not\(\.sidebar-projects\) button \{/);
  // 折叠态和窄屏那两条不用排除：那两种情况下列表本来就不渲染。
  assert.doesNotMatch(css, /^\.sidebar nav button \{/m);
});
