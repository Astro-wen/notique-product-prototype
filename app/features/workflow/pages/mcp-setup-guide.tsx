import Image from 'next/image';
import styles from './mcp-connection.module.css';

export function McpSetupGuide() {
  return <section id="setup-guide" className={styles.guide} aria-labelledby="setup-guide-title">
    <h2 id="setup-guide-title">连接步骤</h2>
    <p className={styles.help}>使用自己的ChatGPT账号。当前Beta共用一个工作空间，授权后读取的是允许共享的Beta资料。</p>
    <div className={styles.guideSteps}>
      <article>
        <h3><span>1</span>登录，再开启上方的只读授权</h3>
        <p>点击上方“登录并继续”，选择自己的登录方式。返回本页后点击“开启只读授权”，确认账号正确、状态为“已授权”。</p>
        <details><summary>查看登录截图</summary>
          <figure className={`${styles.guideShot} ${styles.loginShot}`}>
            <Image src="/guides/assets/login.jpg" alt="ChatGPT登录页，红圈标出登录方式" width={455} height={490} unoptimized />
            <span className={styles.guideRing} style={{left:'4%',top:'12%',width:'92%',height:'41%'}} aria-hidden="true" />
            <span className={styles.guideRing} style={{left:'4%',top:'62%',width:'92%',height:'30%'}} aria-hidden="true" />
          </figure>
        </details>
        <figure className={styles.guideShot}>
          <Image src="/guides/assets/consent.jpg" alt="Notique连接页，红圈标出登录并继续按钮" width={900} height={364} unoptimized />
          <span className={styles.guideRing} style={{left:'2.5%',top:'74%',width:'15%',height:'15%'}} aria-hidden="true" />
        </figure>
        <p className={styles.guideCaption}>未登录时显示“登录并继续”；登录后才会出现授权按钮。</p>
      </article>
      <article>
        <h3><span>2</span>在AI助手里连接Notique</h3>
        <p>Beta 期间可手动添加连接。用自己的账号打开<a href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">ChatGPT插件页</a>。如果没有创建入口，到“设置 → 账户安全与登录”开启开发者模式，再返回插件页。</p>
        <p><strong>① 点击“添加 → 创建MCP应用”。</strong>部分界面显示“创建插件”。</p>
        <figure className={styles.guideShot}>
          <Image src="/guides/assets/notique-mcp-add-menu.jpg" alt="ChatGPT插件页，红圈标出添加按钮和创建MCP应用入口" width={1280} height={720} unoptimized />
          <span className={styles.guideRing} style={{left:'78.5%',top:'2.5%',width:'8%',height:'8%'}} aria-hidden="true" />
          <span className={styles.guideRing} style={{left:'73%',top:'19%',width:'13%',height:'8%'}} aria-hidden="true" />
        </figure>
        <p><strong>② 填名称、服务地址，身份验证选择OAuth。</strong>名称建议填“Notique Beta”，服务地址复制下表。</p>
        <figure className={styles.guideShot}>
          <Image src="/guides/assets/notique-mcp-server-form.jpg" alt="创建插件表单，红圈标出Notique服务地址和高级OAuth设置" width={1280} height={720} unoptimized />
          <span className={styles.guideRing} style={{left:'27.5%',top:'51.5%',width:'45%',height:'8%'}} aria-hidden="true" />
          <span className={styles.guideRing} style={{left:'27.5%',top:'70%',width:'45%',height:'14%'}} aria-hidden="true" />
        </figure>
        <p><strong>③ 展开“高级OAuth设置”，填写客户端ID。</strong>注册方法选“自定义OAuth客户端”，客户端密钥留空，Token端点身份验证方法选“none”。其余自动发现的端点、回调地址和权限范围保持默认。</p>
        <table className={styles.guideConfig}>
          <caption>Notique Beta连接配置</caption>
          <thead><tr><th scope="col">字段</th><th scope="col">填写内容</th></tr></thead>
          <tbody>
            <tr><th scope="row">名称</th><td>Notique Beta</td></tr>
            <tr><th scope="row">服务器URL</th><td><code>https://notique-evidence-workspace.uclae2e12.chatgpt.site/mcp</code></td></tr>
            <tr><th scope="row">身份验证</th><td>OAuth</td></tr>
            <tr><th scope="row">注册方法</th><td>自定义OAuth客户端</td></tr>
            <tr><th scope="row">OAuth客户端ID</th><td><code>oaiapp_o8TJo8E1GDZwe7ias2IdLbG5</code></td></tr>
            <tr><th scope="row">OAuth客户端密钥</th><td>留空</td></tr>
            <tr><th scope="row">Token端点身份验证方法</th><td><code>none</code></td></tr>
          </tbody>
        </table>
        <figure className={styles.guideShot}>
          <Image src="/guides/assets/notique-mcp-client-config.jpg" alt="高级OAuth配置截图，红圈标出实际Site客户端ID，密钥留空，Token验证方法为none" width={1280} height={720} unoptimized />
          <span className={styles.guideRing} style={{left:'53%',top:'51%',width:'31%',height:'9%'}} aria-hidden="true" />
        </figure>
        <p className={styles.guideCaption}>此 Client ID 用于连接当前 Notique 站点，用户可共用，无需申请 API 密钥。开发者账号已验证创建、登录和一次读取；其他个人账号尚未完成验证。</p>
        <p><strong>④ 阅读提示，确认后点击“创建”，再继续连接。</strong>登录与本页只读授权相同的ChatGPT账号。返回插件页后，打开“个人”中的Notique Beta，确认出现“已连接至你的账号”。登录页显示原站点名称“Notique Evidence Workspace Demo”是正常的，请核对站点地址。</p>
        <p>网页和桌面版使用同一账号，在各自的插件页确认Notique Beta已启用。若某个客户端没有创建入口，先在网页完成配置；桌面端仍需确认可以选择该插件。不要将MCP地址填进插件商店搜索框。</p>
      </article>
      <article>
        <h3><span>3</span>新建对话，启用Notique并提问</h3>
        <p>在ChatGPT中选择“工作”模式，新建对话，用@选择刚才创建的“Notique Beta”。可依次复制以下问题：</p>
        <blockquote>列出我在Notique中可以访问的项目。</blockquote>
        <blockquote>整理这个项目最近的沟通重点和跟进事项，区分草稿与已采纳内容。</blockquote>
        <blockquote>给出这些重点的原文证据，并标明不确定的地方。</blockquote>
        <p>若没有读取到资料，请检查本站授权、插件启用状态以及两边的登录账号是否一致。</p>
      </article>
      <article>
        <h3><span>4</span>需要时断开授权</h3>
        <p>回到本页，点击“断开授权”。新的工具读取应被拒绝；之前已经进入AI助手对话的内容不会因此删除。授权有效期为30天，到期后需重新开启。</p>
      </article>
    </div>
    <p className={styles.guideFooter}><a href="/guides/support.html">联系支持</a><a href="/guides/privacy.html">隐私政策</a><a href="/guides/terms.html">使用条款</a></p>
  </section>;
}
