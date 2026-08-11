import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../app/globals.css";
import Home from "../app/page";

function PagesShowcase() {
  return (
    <>
      <div className="pages-showcase-banner" role="note">
        <strong>GitHub Pages 展示版</strong>
        <span>这里展示 Notique 的核心操作界面。完整的真实 API 测试请使用部署服务或本地测试环境。</span>
      </div>
      <Home />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PagesShowcase />
  </StrictMode>,
);
