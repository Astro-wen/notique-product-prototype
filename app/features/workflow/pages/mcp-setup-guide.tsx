import Image from 'next/image';
import styles from './mcp-connection.module.css';

export function McpSetupGuide() {
  return <section id="setup-guide" className={styles.guide} aria-labelledby="setup-guide-title">
    <h2 id="setup-guide-title">一步一步连接自己的AI助手</h2>
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
        <p>使用发布后的Notique安装入口，核对插件名称与读取权限，再完成连接。安装插件和开启本站授权是两个步骤。</p>
        <p className={styles.guidePending}>公开安装入口正在准备。当前创建者的私人插件入口不能直接用于其他账号；发布完成后，这里会提供实际安装链接和对应截图。</p>
        <p>网页和桌面版使用同一账号，各自确认Notique已安装并启用。不要将下方的MCP地址填进插件商店搜索框。</p>
      </article>
      <article>
        <h3><span>3</span>新建对话，启用Notique并提问</h3>
        <p>先列项目，再读取记录，最后核对原文。可以依次复制这三句话：</p>
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
