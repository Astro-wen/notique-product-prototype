import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadRecordingPolicy() {
  const source = await readFile(path.join(root, "lib/domain/browser-recording.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

test("browser recording selects only formats accepted by the existing audio pipeline", async () => {
  const policy = await loadRecordingPolicy();
  assert.equal(
    policy.chooseBrowserRecordingMime((value) => value === "audio/webm"),
    "audio/webm",
  );
  assert.equal(
    policy.chooseBrowserRecordingMime((value) => value === "audio/mp4"),
    "audio/mp4",
  );
  assert.equal(policy.chooseBrowserRecordingMime(() => false), null);
  assert.equal(policy.browserRecordingExtension("audio/webm;codecs=opus"), "webm");
  assert.equal(policy.browserRecordingExtension("audio/mp4"), "m4a");
});

test("recording names and timers are deterministic and upload-safe", async () => {
  const policy = await loadRecordingPolicy();
  assert.equal(
    policy.browserRecordingFilename(new Date("2026-08-12T17:18:19.123Z"), "audio/webm"),
    "notique-recording-2026-08-12T17-18-19-123Z.webm",
  );
  assert.equal(policy.formatRecordingDuration(0), "00:00");
  assert.equal(policy.formatRecordingDuration(65.9), "01:05");
});

test("direct recorder includes permission, pause, preview, retry, save, and cleanup behavior", async () => {
  const recorder = await readFile(path.join(root, "app/direct-recorder.tsx"), "utf8");
  assert.match(recorder, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(recorder, /echoCancellation: true/);
  assert.match(recorder, /recorder\.pause\(\)/);
  assert.match(recorder, /recorder\.resume\(\)/);
  assert.match(recorder, /<audio controls src=\{previewUrl\}/);
  assert.match(recorder, /重新录制/);
  assert.match(recorder, /保存并生成逐字稿/);
  assert.match(recorder, /streamRef\.current\?\.getTracks\(\)\.forEach/);
  assert.match(recorder, /beforeunload/);
});

test("core UI presents one meeting workspace without removing advanced tools", async () => {
  const [page, styles, shelf, landing] = await Promise.all([
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "app/globals.css"), "utf8"),
    readFile(path.join(root, "app/components/material-shelf.tsx"), "utf8"),
    readFile(path.join(root, "app/components/landing-hero.tsx"), "utf8"),
  ]);
  // 记录侧栏在带项目的工作区里任何宽度都不显示，已经删掉，切记录只走顶栏。
  assert.doesNotMatch(page, /simple-meeting-rail/);
  assert.match(page, /meeting-tabs/);
  // 材料 names the files of this communication; the rail's 来源 names a
  // quote's origin. One word no longer means two things on one screen, and
  // 待确认 lives only in the rail where the list itself is.
  assert.match(page, /aria-label="材料"/);
  assert.match(page, />材料 </);
  assert.match(page, /aria-label="本次重点"/);
  assert.doesNotMatch(page, /aria-label="待确认"/);
  assert.match(page, /aria-label="整个项目"/);
  assert.match(page, /<DirectRecorder/);
  assert.match(page, /<MaterialShelf/);
  // 录音入口在两处，各自守住自己的屏：工作区的材料区，和没有项目时的落地页。
  // 以前这条断言落在 page.tsx 里一句脚注上，脚注一删就假失败。
  assert.match(shelf, /直接录音/);
  assert.match(landing, /直接录音/);
  assert.match(page, /查看本次运行详情/);
  // The sidebar names the surface for what it is: the project list and
  // per-project settings, not a mystery toolbox.
  assert.match(page, /项目管理/);
  assert.doesNotMatch(page, /高级工具/);
  assert.match(styles, /\.simple-workspace/);
  assert.match(styles, /@media \(max-width: 800px\)[\s\S]*\.simple-event-select \{ display: grid !important; \}/);
  assert.doesNotMatch(styles, /simple-meeting-rail/);
});

test("the no-project screen is a landing page, not an empty copy of the workspace", async () => {
  const [page, landing, styles] = await Promise.all([
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "app/components/landing-hero.tsx"), "utf8"),
    readFile(path.join(root, "app/globals.css"), "utf8"),
  ]);
  // 工作区整块只在选中项目后渲染。以前它照样渲染，只是左边那栏写着「记录 0
  // 次 / 还没有记录」，右边三个标签页一个都点不动。
  assert.match(page, /\{project && <section className="simple-workspace"/);
  assert.match(page, /\{!project && <LandingHero/);
  // 四个入口对应四种材料，说明文字各说各的事，不重复。
  for (const entry of ["直接录音", "上传音频", "上传文件", "上传图片"]) {
    assert.ok(landing.includes(`<strong>${entry}</strong>`), `落地页缺少入口：${entry}`);
  }
  // 拖放区照旧是主入口，整块落地页都是放置目标。
  assert.match(landing, /landing-dropzone/);
  assert.match(landing, /onDrop=/);
  assert.match(styles, /\.landing\.is-dropping \.landing-dropzone/);
});

test("the greeting reads the local clock without claiming the server knows it", async () => {
  const { greetingFor } = await import("../lib/domain/greeting.ts");
  assert.equal(greetingFor(2), "夜深了");
  assert.equal(greetingFor(9), "早上好");
  assert.equal(greetingFor(14), "下午好");
  assert.equal(greetingFor(21), "晚上好");
  // 边界属于后一档，午夜和正午都不会落进上一段。
  assert.equal(greetingFor(5), "早上好");
  assert.equal(greetingFor(12), "下午好");
  assert.equal(greetingFor(18), "晚上好");
  assert.equal(greetingFor(0), "夜深了");

  const landing = await readFile(path.join(root, "app/components/landing-hero.tsx"), "utf8");
  // 服务端没有用户的时钟，所以那一侧渲染成空。用 useSyncExternalStore 的服务端
  // 快照声明这处两边不同，React 才不会当成 hydration 错误去纠正。
  assert.match(landing, /useSyncExternalStore\(subscribeToNothing, clientGreeting, serverGreeting\)/);
  assert.match(landing, /const serverGreeting = \(\) => "";/);
});
