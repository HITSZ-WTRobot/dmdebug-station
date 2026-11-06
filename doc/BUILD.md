# 源码开发与构建

[文档索引](README.md) · [发布与下载](RELEASE.md)

## 环境与平台边界

- 网页开发需要Node.js和npm；现有回归测试要求Node.js **24.14或更高兼容版本**。
- Windows桌面使用Rust工具链、Tauri v2、MSVC C++构建工具和Windows SDK；运行需要WebView2 Runtime。
- 依赖版本由根目录`package-lock.json`与`src-tauri/Cargo.lock`记录。首次安装使用`npm ci`，避免无意更新锁文件。
- 下列桌面开发命令对应目前Windows流程。WinMM输入诊断/桌面手柄采集与经典蓝牙RFCOMM/SPP直连是**Windows-only**；普通网页不提供这些原生能力。
- macOS/Linux原生串口、协议演示及桌面产物的可用性须等待对应CI构建/检查结果，尚不能声称已构建或运行成功。浏览器版另依赖实际浏览器的Web Serial/Gamepad API支持，不等同于原生桌面平台验证。跨平台发布命令和产物以[RELEASE](RELEASE.md)为准。

## 安装、开发与测试

```sh
git clone https://github.com/HITSZ-WTRobot/dmdebug-station.git
cd dmdebug-station
npm ci
npm run dev
```

在仓库根目录运行确定性回归：

```sh
npm test
```

测试使用Node内置测试框架，无额外测试运行器；TypeScript参数属性通过`--experimental-transform-types`及`tests/register-typescript.mjs`运行，会打印实验性功能提示，不影响打包后的应用。历史测试数量与覆盖范围见[VALIDATION](VALIDATION.md)，不把旧数量写成当前固定总数。

## 网页与Windows桌面构建

```sh
# TypeScript检查、Vite构建和便携单文件导出
npm run build:web

# Windows：Tauri桌面构建，同时更新根目录DMDebugStation.exe
npm run build:all
```

- `build:web`调用`build`：`tsc && vite build && node scripts/export-portable.mjs`。
- `build:all`调用`build:desktop`；Tauri的`beforeBuildCommand`执行同一前端构建，再构建桌面程序，最后由`copy-desktop.mjs`复制Windows release EXE到根目录。现有复制脚本使用Windows EXE路径，不把这条本地命令当作已验证的macOS/Linux打包流程。
- `dist/`是桌面使用的Web资源；`web/index.html`与`web/串口.html`由同一构建导出，JS/CSS及浏览器Worker内联，不依赖额外worker文件、外部字体或CDN。两份便携文件内容相同，不另维护第二套协议或界面。
- 网页入口需下载到本地，用支持Web Serial和`Promise.withResolvers`的当前Chrome/Edge（建议124+）打开。GitHub源码预览页不能授权串口。
- 修改源码后重新构建对应入口，不继续使用旧EXE或旧HTML；具体启动、连接与安全顺序见[USAGE](USAGE.md)。

## 产物与Git

`node_modules/`、`dist/`、`src-tauri/target/`、EXE和日志被Git忽略；便携网页作为交付入口随源码更新。发布下载与三平台产物说明集中在[RELEASE](RELEASE.md)。

组织仓库为[HITSZ-WTRobot/dmdebug-station](https://github.com/HITSZ-WTRobot/dmdebug-station)。首次发布记录保留已有本地提交及开发分支，`main`以当时最新串口修复版初始化；后续工作从`main`创建功能/修复分支，按职责提交并通过组织仓库PR审核，不强推、不重写已有历史。此约定不是在文档迁移时切分支或提交的指令；现有未合入功能保持原分支。
