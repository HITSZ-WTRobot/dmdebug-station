# 跨平台发布

正式包见 [GitHub Releases](https://github.com/HITSZ-WTRobot/dmdebug-station/releases)。发布版本、源代码标签和包内版本须一致；当前版本由根 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`Cargo.lock` 及 `tauri.conf.json` 共同记录。

## 下载与运行

| 产物 | 平台 | 入口与前提 |
|---|---|---|
| `DMDebugStation-windows-x64.exe` | Windows x64 | 直接运行；需要 WebView2 Runtime。EXE 未代码签名。 |
| `DMDebugStation-linux-x64.AppImage` | Linux x64 | `chmod +x DMDebugStation-linux-x64.AppImage` 后运行；构建基线为 Ubuntu 22.04。系统仍须支持图形桌面及 AppImage；无 FUSE 的环境可使用 `--appimage-extract-and-run`。 |
| `DMDebugStation-macos-universal.zip` | macOS Intel / Apple Silicon | 解压后将 `DMDebugStation.app` 放入 Applications。构建目标为 macOS 11.0+，包含 x86_64 与 arm64；未使用 Developer ID 签名、未公证，仅有本地 ad-hoc 签名。首次打开按系统“隐私与安全性”流程确认来源，不关闭系统安全保护。 |
| `DMDebugStation-web.zip` | 支持 Web Serial 的 Chrome / Edge | 解压并打开 `web/index.html` 或 `web/串口.html`；JS/CSS 已内联，包含本版 `doc/`。浏览器和系统须实际提供 Web Serial。 |
| `SHA256SUMS` | 全平台 | 对应上面四个文件的 SHA-256。 |

Windows 可用 `Get-FileHash .\DMDebugStation-windows-x64.exe -Algorithm SHA256`，Linux 用 `sha256sum DMDebugStation-linux-x64.AppImage`，macOS 用 `shasum -a 256 DMDebugStation-macos-universal.zip`，逐项对照 `SHA256SUMS`。

三端有不同的系统能力：WinMM 手柄遥控、输入诊断与经典蓝牙 RFCOMM/SPP 直连仅支持 Windows。Linux/macOS 版本使用原生串口与协议演示；串口权限由系统管理。网页使用浏览器串口与 Gamepad API，不能替代原生 RFCOMM 或 Ozone TCP 后端。完整限制见[使用说明](USAGE.md)、[手柄与诊断](GAMEPAD.md)及 [Ozone](OZONE.md)。

底盘旋转上限为 ±360°/s，手柄合成平移 0.4m/s、软件轮速包络 360rpm；必须配套更新[固件](https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST)。旧 10°/s、160rpm 固件会被新版手柄准入检查拒绝。打包、启动与回归测试均不证明真实电机转速、机械安全或无线实时性；下载后不会自动连接、使能或续跑。

## 从源码打包

先按[构建说明](BUILD.md)安装 Node.js 24、Rust 与对应系统的 Tauri v2 构建依赖，再从仓库根目录执行 `npm ci`。

Windows x64：

```sh
npm run build:all
```

Linux x64 安装 WebKitGTK 4.1、AppIndicator、librsvg、patchelf、libudev 的开发包后：

```sh
npm run tauri -- build --ci --target x86_64-unknown-linux-gnu --bundles appimage --config '{"bundle":{"active":true}}'
```

macOS 通用包需要 Xcode Command Line Tools 及两个 Rust 目标：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
MACOSX_DEPLOYMENT_TARGET=11.0 APPLE_SIGNING_IDENTITY=- npm run tauri -- build --ci --target universal-apple-darwin --bundles app --config '{"bundle":{"active":true}}'
```

macOS 的 `.app` 在 `src-tauri/target/universal-apple-darwin/release/bundle/macos/`；Linux AppImage 在对应目标的 `release/bundle/appimage/`。`npm run build:all` 目前是 Windows 便携 EXE 的本地复制入口，不把它当作 Linux/macOS 打包命令。

## 维护者发布流程

[Release 工作流](../.github/workflows/release.yml)由 `v*` 标签推送触发：

1. 在功能分支完成模块提交与文档检查，推送 GitHub，经 PR 在云端合入 `main`；不以本地合并代替云端合入。
2. 同步五处版本元数据，版本变更同样经 PR 合入；标签必须是根版本的 `v` 前缀形式。
3. 在已合入的确定提交上创建并推送该版本标签。标签不应移动或复用为另一份源代码。
4. Windows、Ubuntu 与 macOS runner 分别执行 Node/Rust 回归并构建原生产物；macOS 使用 `lipo` 检查两个架构。另一个 job 构建便携网页并打包文档。
5. 只有四类产物全部成功，发布 job 才校验完整资产集合、生成 SHA-256 清单并创建 GitHub Release。构建失败不能用另一平台文件改名替代，也不能把部分产物称为完整发布。
6. 最后核对 Actions 结论、Release 的标签/提交与五个附件。构建或回归成功不等于每个系统、串口设备或机构都完成实机验证；实测边界记录在[验证记录](VALIDATION.md)。

工作流只使用 GitHub 自动提供的最小权限 `GITHUB_TOKEN`；不把个人令牌、证书或密码提交到源码。默认不上传 Apple Developer ID 或 Windows 签名证书，不宣称签名、公证或系统信任状态。
