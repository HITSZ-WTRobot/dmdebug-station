# DMDebug Station 文档

用于 STM32H723 三路 FDCAN 工程的设备工作台；Windows、Linux、macOS桌面与便携网页共用 React/TypeScript 界面，按总线展示九个控制单元、十二台电机。上位机提供交互和协议，不承担电机实时控制，不修改 CubeMX 外设配置。

## 按任务阅读

| 文档 | 内容 |
|---|---|
| [使用与安全](USAGE.md) | 入口、握手、设备编号/单位、位置与速度操作、软件零点、曲线、断线恢复 |
| [手柄、蓝牙与输入诊断](GAMEPAD.md) | HC-05接线/配对、固定映射、Start门禁、WinMM只读记录 |
| [Ozone直接内存调参](OZONE.md) | 匹配ELF、RAM读写、字段/镜像、参数文件与风险 |
| [源码开发与构建](BUILD.md) | 依赖、Windows开发命令、便携网页导出、平台限制 |
| [架构与通信契约](ARCHITECTURE.md) | 源码地图、Rust actor与浏览器Worker、事务和超时预算 |
| [历史验证与边界](VALIDATION.md) | 已有回归、界面/模型观察和未完成的实物验证 |
| [Release发布与下载](RELEASE.md) | 发布入口与平台产物说明 |

## 运行入口与配套资料

- [GitHub Releases](https://github.com/HITSZ-WTRobot/dmdebug-station/releases)：发布下载入口；平台产物及验证情况以对应Release说明为准。
- 便携网页：[web/index.html](../web/index.html)、[web/串口.html](../web/串口.html)。下载到本地后用当前Chrome/Edge打开；GitHub源码预览不是运行入口。
- Windows桌面：`DMDebugStation.exe`，需要WebView2 Runtime；源码构建见[BUILD](BUILD.md)。
- 配套固件：[HITSZ-WTRobot/FDCAN_DM_TEST](https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST)。
- 字节契约：[设备控制协议v2](https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST/blob/main/doc/SERIAL_PROTOCOL.md)。
- 实板流程：[电机通信检查与调参步骤](https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST/blob/main/doc/MOTOR_TEST_GUIDE.md)。

程序不自动连接、演示、使能或恢复旧目标。WinMM诊断/桌面手柄和经典蓝牙SPP直连仅支持Windows；macOS/Linux桌面使用原生串口与演示，构建与回归结论以对应版本CI/Release为准，不能由Windows或网页验证推定真实设备可用。首次操作先阅读使用文档的安全边界。
