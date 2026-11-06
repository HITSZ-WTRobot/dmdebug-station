# dmdebug上位机

STM32H723 三路FDCAN电机工程的串口工作台：设备发现、状态/参数查询、位置与速度控制、实时曲线、CSV和通信记录。Windows桌面与便携网页共用源码；上位机不承担电机实时控制。

## 使用入口

- [Release下载](https://github.com/HITSZ-WTRobot/dmdebug-station/releases) · [发布说明](doc/RELEASE.md)
- 网页：下载 [web/index.html](web/index.html) 或 [web/串口.html](web/串口.html)，用当前Chrome/Edge打开。
- Windows桌面：`DMDebugStation.exe`，需要WebView2；操作前阅读[使用与安全](doc/USAGE.md)。
- [文档索引](doc/README.md)：[构建](doc/BUILD.md) · [手柄/蓝牙/诊断](doc/GAMEPAD.md) · [Ozone](doc/OZONE.md) · [架构](doc/ARCHITECTURE.md) · [验证边界](doc/VALIDATION.md)
- 配套固件：[FDCAN_DM_TEST](https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST) · [协议v2](https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST/blob/main/doc/SERIAL_PROTOCOL.md) · [实板联调](https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST/blob/main/doc/MOTOR_TEST_GUIDE.md)

## 源码命令

Node.js 24.14+兼容版本、npm；Windows桌面另需Rust、MSVC和Windows SDK，详见[构建文档](doc/BUILD.md)。

```sh
git clone https://github.com/HITSZ-WTRobot/dmdebug-station.git
cd dmdebug-station
npm ci
npm run dev        # 网页开发
npm test           # 确定性回归
npm run build:web  # 检查、构建并导出便携网页
npm run build:all  # Windows桌面，更新DMDebugStation.exe
```

WinMM诊断/桌面手柄与蓝牙SPP直连当前仅支持Windows；macOS/Linux原生串口/演示可用性待对应CI结果确认，不能视为已验证。
