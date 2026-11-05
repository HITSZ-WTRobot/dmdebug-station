# dmdebug上位机

用于 STM32H723 三路 FDCAN 电机工程的串口调试工作台。提供 Windows 桌面程序和免安装单文件网页，支持设备发现、状态与参数查询、位置/底盘速度命令、实时曲线、CSV 导出和收发记录。

- 配套下位机：[HITSZ-WTRobot/FDCAN_DM_TEST](https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST)。
- 串口契约：[设备控制协议 v2](https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST/blob/main/SERIAL_PROTOCOL.md)。
- 联调与调参：[电机通信检查与调参步骤](https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST/blob/main/MOTOR_TEST_GUIDE.md)。
- 详细使用说明：[web/README.md](web/README.md)。

## 支持的设备

| 总线 | 控制单元 | 单位与控制方式 |
|---|---|---|
| FDCAN1 | 四台伸缩 DM-S3519、两台关节 DM-J4340P | 伸缩为绝对 mm，关节为绝对 deg；下位机 S 曲线规划、电机内部 MIT 跟踪 |
| FDCAN2 | 四轮 DM-S3519 全向底盘 | 车体系 vx/vy 为 m/s，wz 为 deg/s；电机内部速度环 |
| FDCAN3 | 两台独立 M2006/C610 | 减速后输出轴绝对 deg；下位机轨迹速度前馈、位置 PD 和速度 PID |

共九个控制单元、十二台电机。上位机负责交互与协议，不承担电机实时控制，也不修改 CubeMX 外设配置。

## 运行入口

### 单文件网页

使用当前 Chrome/Edge 打开仓库中的 [web/index.html](web/index.html) 或 [web/串口.html](web/串口.html)。两份文件由同一源码生成，JS/CSS 已内联，不需要启动开发服务器。

选择“浏览器串口”，点击“连接固件”并授权实际串口。浏览器须支持 Web Serial 和 `Promise.withResolvers`，建议使用当前版本 Chrome/Edge（124+）。GitHub 的源码预览页不是串口运行入口，需要将网页下载到本地后打开。

### Windows 桌面

从源码执行下文的 `npm run build:all` 后，运行项目根目录的 `DMDebugStation.exe`，选择“桌面原生串口”及对应 COM 端口。需要 Microsoft Edge WebView2 Runtime。EXE 不纳入 Git 历史，本仓库不承诺已发布可下载的二进制 Release。

串口固定为 **115200 baud、8N1、无流控**。不要让多个程序同时占用同一端口；“协议演示 · 无硬件”仅供明确选择的演示，不是串口失败时的自动后备模式。

## 首次联调

1. 支撑机构、架空底盘四轮，确认硬件急停和安全空间；先保持所有设备失能。
2. 连接固件，依次确认“端口打开”“固件握手”“电机反馈”；端口打开不代表电机在线。
3. 逐台点击“刷新状态与参数”，确认反馈新鲜、有效反馈计数增长、零点建立且无故障；底盘检查四轮状态。
4. 一次只明确使能一台，发送已确认安全的小目标，依据新反馈判断使能与到位，不以 ACK 代替执行完成。
5. 测试结束先失能、核对新反馈并按现场流程隔离动力，再断开串口。

详细的按钮顺序、单位、故障恢复和参数调整限制见配套的[联调与调参步骤](https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST/blob/main/MOTOR_TEST_GUIDE.md)。当前 MIT/PID 参数为只读，不能通过本界面在线修改或保存；DM 运动约束可在失能时显式应用到 RAM。

## 开发、测试与构建

网页开发需要 Node.js 与 npm；运行现有回归测试使用 Node.js **24.14 或更高兼容版本**。Windows 桌面构建还需要 Rust 工具链、MSVC C++ 构建工具和 Windows SDK，运行时需要 WebView2。

```sh
git clone https://github.com/HITSZ-WTRobot/dmdebug-station.git
cd dmdebug-station
npm ci

# 启动开发页面
npm run dev

# 通信调度的确定性回归测试
npm test

# 类型检查、网页构建和便携单文件导出
npm run build:web

# Windows 桌面构建，同时更新根目录 DMDebugStation.exe
npm run build:all
```

`npm test` 使用 Node 内置测试框架；现有 TypeScript 参数属性通过实验性转换开关运行，会打印 Node 的实验性功能提示，不影响构建后的应用。依赖版本由 `package-lock.json` 和 `src-tauri/Cargo.lock` 记录。

修改源码后应重新构建对应入口，不要继续运行旧 EXE 或旧 HTML。`node_modules/`、`dist/`、`src-tauri/target/`、EXE 和日志被 Git 忽略；便携网页作为交付入口随源码提交。

## 代码结构

| 目录/文件 | 职责 |
|---|---|
| `src/App.tsx` | 工作台布局、设备选择、状态展示和操作交接 |
| `src/components/` | 设备控制、曲线与收发记录组件 |
| `src/lib/protocol.ts` | 协议 v2 定长帧、CRC、设备与单位解码 |
| `src/lib/transport.ts` | 单请求在途、握手、重试与连接专属 Worker 通信时钟 |
| `src/lib/demo.ts` | 显式选择的协议演示，不模拟真实电机动力学 |
| `src/store/` | 会话和设备状态契约 |
| `src-tauri/src/` | Windows 原生串口打开、读写及前端事件交接 |
| `tests/` | 受控时钟与串口边界下的通信行为回归 |
| `scripts/` | 网页内联导出与桌面产物复制 |

## 通信与安全边界

- 协议为 64 字节定长帧、CRC-16/CCITT-FALSE、单请求停等。全设备广播收齐九台应答，四轮查询收齐四个轮位；序号匹配，最多一次同字节重试，不以新序号自动重发不确定的运动命令。
- 心跳与轮询由连接专属的内联 Blob Worker 节拍唤醒，所有写口仍由唯一事务队列执行；避免 Window 后台计时节流造成通信间断，不积压轮询请求。
- 下位机 **500 ms 失联门禁不放宽**。系统休眠、主线程完全冻结、USB 或真实串口故障仍可能触发停机；Worker 不是硬实时或硬件安全保证。
- 串口失联原因与 CAN 离线分开判断：配套修复版固件的串口结果 107 为 LinkFault，结果 1 为真正电机反馈离线。新心跳不自动恢复使能或旧目标。
- “停止 / 保持”不等于失能或硬件急停；断开串口、暂停图表、暂停 CPU 都不能保证机构停止。DM 当前电机端 CAN Timeout 为 0，仍须使用机械支撑及硬件急停。

## 验证状态

已有八项确定性通信回归通过，覆盖后台窗口计时器不调度、广播/四轮缺帧、同字节重试、单请求在途及旧会话隔离。网页与 Windows 桌面构建通过；便携网页演示握手与持续收发、Windows 初始窗口和串口枚举已观察。

受控浏览器节流试验只证明该软件路径得到改善，未连接真实 COM 或电机进行本轮修复后的实板联调；不将协议演示、模型结果或编译成功表述为带载稳定、安全或故障已在现场消失。

## Git 管理

组织仓库为 [HITSZ-WTRobot/dmdebug-station](https://github.com/HITSZ-WTRobot/dmdebug-station)。首次发布保留已有本地提交和开发分支，`main` 以当前最新串口修复版初始化。后续从 `main` 建功能/修复分支，按职责提交，再通过组织仓库 PR 审核合入；不强推或重写已有历史。
