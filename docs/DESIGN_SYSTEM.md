# Notique 前端视觉库

访问 `/design-system`；可下载 `/design-system/tokens.json`。实现位于 `app/components/notique-ui.tsx`，设计变量及样式集中在 `app/globals.css`。

## 来源与验证范围

2026-09-28 实际访问 [Notique](https://app.notiqueai.com/)，读取公开 CSS 和 JavaScript。无登录会话，仅直接验证了登录页；预加载资源揭示了部分内部组件结构，但不代表已核对登录后的全部页面。官网是 Nuxt/Vue，本项目是 React/Radix，因此复用视觉约定、结构和组件边界，不把编译后的整站脚本搬入应用。

| 来源 | 已观察到的内容 | 本项目适配 |
| --- | --- | --- |
| `/_nuxt/entry.BCNbfqNB.css` | 黑色主按钮、蓝色强调、6px 圆角；Noto Sans TC/PingFang；灰色辅助文字 | 全局色彩、字体栈、按钮基础样式 |
| `/_nuxt/BaseDialog.CXMeE5hw.css` 和 `T1rEUKba.js` | 确认/取消按钮、disabled、弹窗标题；8px 圆角、半透明黑遮罩 | 保留现有 Radix 的焦点、键盘和关闭行为，统一外观 |
| `/_nuxt/FirstProjectPage.CzmkR8DO.css` 和 `DYea4HJt.js` | 居中空状态、42px 高轮廓按钮、新建入口 | 统一按钮尺寸与内容层级，不复制业务状态 |
| `/_nuxt/MainContentTopToolBar.DIN1QIIq.css` 和 `D25oXMHT.js` | 工具栏与页面状态相关控制 | 仅提取样式参考，未引入其业务代码 |
| `/_nuxt/default.B0DCKadC.css` | 页面、导航和卡片基础规则 | 白色面板、浅底色、边框层次 |

参考资源的本地副本在被 Git 忽略的 `outputs/notique-reference/`。以上是观测时的带哈希 URL，未来发布可能改变。无账号凭据、官网客户数据或商业宣传图片进入代码。

## 视觉约定

黑色 #0d0d0d 用于文字及主要操作；#59657b 用于辅助文字；#4b75f2 用于品牌强调；#e6e6e8 用于分隔。#f9fafb 画布、#edf2ff 选中背景和深蓝 #2d56cf 是本项目适配值。深蓝用于白底小字和带白字的强调按钮，避免直接照搬浅色造成可读性不足。状态绿色保留给成功/已确认，不与导航混用。

常用正文 16px、标签 14px，辅助文字至少 12px；现有业务页面仍有历史尺寸，未宣称全面完成字号审计。字体优先使用用户系统已安装的中文字体，不额外下载官网字体文件。按钮 6px、卡片 10px、弹窗 8px 圆角。已有 `--brand-green*` 变量暂时保留为蓝色兼容别名，避免一次性改动全部业务选择器。

## 可复用组件

- `NqButton`：primary / secondary / quiet / accent / danger，disabled 和 loading；默认 type=button。
- `NqIconButton`：要求 label，用于弹窗关闭等图标操作。
- `NqActionCard`：复用到首页录音、音频、文字、图片入口；保留现有上传和录音回调。
- `NqSurface`：带统一边框、留白和圆角的内容面板。
- `NqStatus`：info / success / pending / error；状态必须有文字。
- `Modal`：继续复用现有 Radix 对话框，不另起一套焦点管理。

视觉库有按钮状态、字段、四类记录入口、支持键盘的 Tabs、行动建议采纳/撤销和可关闭的弹窗示例。示例全部为本地组件状态，不请求麦克风、不上传、不触发付费模型、不修改项目。

## 本次范围与后续

已应用全局变量、按钮、上传卡片、弹窗、项目卡片的选中/悬停色。保留 main 已精简的产品流程，不恢复手写事实、手写行动、负责人或截止日期表单。

后续拿到授权的登录后页面或源码组件库时，再核对真实导航、列表密度、阅读面板和响应式布局。当前交付是有来源的风格适配及组件库，不能称为官网全部界面的像素级同步。
