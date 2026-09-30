# Notique 前端视觉库

访问 `/design-system`，设计变量下载地址为 `/design-system/tokens.json`。项目管理与视觉库复用 `NqProjectCard`，批阅操作与视觉库复用 `NqButton`。实现集中在 `app/components/notique-ui.tsx`、`app/globals.css` 和记录工作区样式。

## 来源与验证范围

2026-09-30 通过已登录的 [Notique](https://app.notiqueai.com/) 实际查看项目管理、时间线和原文页面，读取 DOM、计算样式、31份发布 CSS，并检查相关编译 JavaScript。采集记录位于被 Git 忽略的 `outputs/notique-reference/2026-09-30/`。样式依据、组件约定与实现顺序位于 `docs/notique-design/`。

| 组件 | 官网实测 | 本项目应用 |
| --- | --- | --- |
| 基础样式 | 画布 #f5f6f8、主文字 #0d0d0d、辅助 #59657b、分隔 #e6e6e8 | 全局变量与共用字体栈 |
| 项目卡 | 高89px、最大宽305px、16px圆角、2px边框、标题14px/21px | NqProjectCard，同一组件用于项目管理与视觉库 |
| 项目状态 | 悬停与选中浅蓝 #e5f0ff、品牌蓝边框 | 项目卡悬停、批量选中 |
| 按钮 | 36/42/44px、6px圆角、普通操作14px/20px | NqButton 的 compact/regular/large |
| 禁用操作 | 底色 #e6e6e8、文字 #a0a0a0、opacity 1 | 共用实心与轮廓按钮 |
| 原文块 | 16px/26px、12px 16px留白、8px圆角 | 实际原文面板与视觉库 |
| 弹窗 | 标题、关闭、确认/取消及禁用状态 | 现有 Radix Modal，保留焦点与键盘行为 |

官网为 Nuxt/Vue，本项目为 React/Radix。发布 CSS 和 DOM 提供样式与结构依据，组件通过本项目的共用实现接入。编译资源采集和应用源码复用分别记录。

## 视觉约定

字体栈沿用 Noto Sans TC、PingFang TC、Roboto 和系统后备字体。正文16px，标签14px，辅助信息12px。项目卡圆角16px、按钮6px、原文和弹窗8px。品牌蓝 #4b75f2 用于选中与链接，深蓝 #2d56cf 用于小字和白字强调操作。绿色表示已确认或完成。键盘焦点与状态文字继续保留。

tokens.json 将官网观测值与可读性适配值分开记录。业务信息继续遵循主题分组、批阅、问题回答、行动执行和结果回流的现有接口。

## 可复用组件

- NqButton：primary、secondary、quiet、accent、danger，三种尺寸及 loading/disabled
- NqProjectCard：名称直接打开项目，更多操作提供重命名、关联文件夹、导出和删除
- NqIconButton：提供明确可读的操作名称
- NqActionCard：首页录音、音频、文字与图片入口
- NqSurface、NqStatus：内容容器与带文字的状态
- Modal：复用 Radix 的关闭、焦点返回和键盘行为

## PC验收

视觉库实测1440×900：按钮36px、项目卡305×89px、原文16px/26px与12px 16px留白，无横向溢出。通过项目示例菜单打开弹窗，Escape关闭后焦点返回原菜单按钮。项目管理实际卡片为89px高，名称点击进入项目，更多菜单保留独立入口。

1366×768实际项目列表与原文面板无横向溢出。批量选择显示已选数量和浅蓝状态，退出后恢复普通入口。生产发布后页面和主题跟进链接按发布验收记录补齐。工程测试、页面点击与模型质量分别记录。
