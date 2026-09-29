import { expect, test } from "@playwright/test";

test("PC reading controls use the public Notique palette without recoloring success", async ({ page }, testInfo) => {
  await page.goto("/design-system");
  await expect(page.getByRole("heading", { name: "让每一次记录，清晰一致。" })).toBeVisible();

  // Render the legacy reading selectors beside the component catalog so their
  // actual computed styles, including cascade overrides, are exercised.
  await page.evaluate(() => {
    const probe = document.createElement("section");
    probe.className = "interface-refresh";
    probe.dataset.testid = "pc-style-probe";
    probe.style.cssText = "position:fixed;top:16px;right:16px;z-index:100;padding:16px;width:420px;background:#fff;border:1px solid #e6e6e8;border-radius:10px;box-shadow:0 4px 12px #00000026";
    probe.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <button class="button primary" type="button">确认并继续</button>
        <button class="button secondary" type="button">查看原文</button>
        <span class="nq-status success">已完成</span>
      </div>
      <div class="result-nav-primary"><button class="active" type="button">本次重点</button></div>
      <div class="reader-reading-pane"><div class="summary-sentences">
        <article class="summary-reveal-line selected"><div class="summary-point-copy"><span>重点 1</span><mark>已选中的原文重点</mark></div></article>
      </div></div>
      <button class="summary-expand-button" type="button">展开原文</button>
      <button class="text-button" type="button">查看详情</button>`;
    document.body.appendChild(probe);
  });

  const probe = page.getByTestId("pc-style-probe");
  const primary = probe.locator(".button.primary");
  await expect(primary).toHaveCSS("background-color", "rgb(13, 13, 13)");
  await expect(primary).toHaveCSS("border-radius", "6px");
  await expect(primary).toHaveCSS("min-height", "42px");
  await expect(primary).toHaveCSS("font-size", "14px");
  await expect(probe.locator(".result-nav-primary button.active")).toHaveCSS("color", "rgb(45, 86, 207)");
  await expect(probe.locator(".summary-reveal-line.selected")).toHaveCSS("background-color", "rgb(237, 242, 255)");
  await expect(probe.locator(".summary-reveal-line.selected")).toHaveCSS("border-left-color", "rgb(75, 117, 242)");
  await expect(probe.locator(".summary-expand-button")).toHaveCSS("color", "rgb(45, 86, 207)");
  await expect(probe.locator(".text-button")).toHaveCSS("color", "rgb(45, 86, 207)");
  await expect(probe.locator(".nq-status.success")).toHaveCSS("color", "rgb(29, 125, 93)");

  await page.screenshot({ path: testInfo.outputPath("pc-reading-style.png") });
  await primary.hover();
  await expect(primary).toHaveCSS("background-color", "rgb(48, 48, 48)");
});
