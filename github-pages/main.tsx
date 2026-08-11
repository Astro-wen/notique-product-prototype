import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import "./pages.css";

const APP_URL = "https://notique-evidence-workspace.uclae2e12.chatgpt.site";

function PagesLauncher() {
  useEffect(() => {
    const timer = window.setTimeout(() => window.location.replace(APP_URL), 700);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="launcher-shell">
      <section className="launcher-card" aria-labelledby="launcher-title">
        <span className="launcher-mark" aria-hidden="true">N</span>
        <p className="launcher-kicker">Notique 核心测试环境</p>
        <h1 id="launcher-title">正在打开完整版本</h1>
        <p className="launcher-copy">
          完整版本支持上传 Transcript、现场照片和录音。录音会先生成带说话人与时间点的逐字稿，再进入证据提取、人工核对和项目结果。
        </p>
        <a className="launcher-button" href={APP_URL}>立即进入</a>
        <p className="launcher-note">如果页面没有自动打开，请点击上面的按钮。</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PagesLauncher />
  </StrictMode>,
);
