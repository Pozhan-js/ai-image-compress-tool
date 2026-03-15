# AI 图片压缩工具

基于需求分析与技术方案搭建的最小可运行项目骨架。

## 当前包含
- React + Vite 前端工作台主页
- Node.js + Express API 骨架
- npm workspaces monorepo 结构
- shared 类型包占位

## 启动

```bash
npm install
npm run dev
```

默认会同时启动：
- 前端开发服务 http://localhost:5173
- 后端 API http://localhost:3001
- Electron 桌面应用窗口

如果只想单独启动桌面端壳：

```bash
npm run dev:desktop
```

## 桌面端说明

桌面端使用项目内 Electron 运行时（npm 依赖），避免 Homebrew Cask 应用被 Gatekeeper 拦截导致“已损坏”弹窗。
