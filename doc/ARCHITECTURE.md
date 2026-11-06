# 架构与通信契约

[文档索引](README.md) · [使用与安全](USAGE.md) · [手柄与蓝牙](GAMEPAD.md)

桌面与便携网页共用React/TypeScript界面、协议v2和设备状态契约，不再维护旧v1/六设备逻辑。当前为九个控制单元、十二台电机；逻辑编号不等于所有原始CAN ID。精确字节定义以配套固件[设备控制协议](https://github.com/HITSZ-WTRobot/FDCAN_DM_TEST/blob/main/doc/SERIAL_PROTOCOL.md)为准。

## 源码地图

| 目录/文件 | 职责 |
|---|---|
| `src/App.tsx` | 工作台布局、设备选择、状态展示和操作交接 |
| `src/components/` | 设备控制、遥测曲线、收发记录、手柄和诊断页 |
| `src/lib/protocol.ts` | v2定长帧、CRC、设备与单位解码 |
| `src/lib/transport.ts`、`src/lib/native-transport.ts` | 桌面IPC/事件薄适配；浏览器独立Web Serial/Worker调度与显式演示 |
| `src/lib/demo.ts` | 浏览器协议演示，不模拟真实电机动力学 |
| `src/components/OzoneTuningPage.tsx`、`src/lib/tuning.ts` | Ozone字段草稿、逐字段确认与参数文件 |
| `src/store/` | 会话和设备状态契约 |
| `src-tauri/src/native.rs`、`native_demo.rs`、`wire.rs` | 原生协议actor、演示字节边界、帧契约 |
| `src-tauri/src/bluetooth.rs`、`bluetooth/` | Windows已配对SPP枚举和RFCOMM字节流 |
| `src-tauri/src/input/`、`gamepad.rs`、`diagnostics.rs` | WinMM共享采集、遥控状态机和独立线程诊断日志 |
| `src-tauri/src/ozone.rs` | Ozone TCP、符号地址解析与实际RAM读写 |
| `tests/` | 受控时钟、串口边界、手柄与调参行为回归 |
| `scripts/` | 网页内联导出和Windows桌面产物复制 |

## 所有权与生命周期

桌面串口、RFCOMM及协议演示互斥地由同一Rust actor拥有；序号、CRC、握手、轮询、心跳、单在途队列、手柄最新值和失能优先规则共享。蓝牙只增加物理字节流，不另建调度器。React只提交意图、显示状态；切换设备或Ozone页不重建通信引擎。打开链路使用可取消worker，资源按会话epoch归属，旧完成不能复活新连接。

浏览器没有本机Rust进程，使用Web Serial、内联Worker时钟和真实Gamepad API；采样仍受页面生命周期影响。串口与桌面入口不能同时占同一设备；浏览器限制不能解释成桌面能力，普通网页不能建立Ozone原始TCP或经典RFCOMM。

## 事务、时钟与截止时间

| 项目 | 当前约束 |
|---|---|
| 帧和匹配 | 64字节定长帧、CRC-16/CCITT-FALSE；单请求停等，按sequence/opcode/设备集合匹配 |
| 广播与Wheels | 全设备收齐九个不同设备应答；Wheels收齐四轮，部分应答不是完成 |
| 原COM/网页 | 普通事务150ms，最多一次同字节重试；速度命令均不重试 |
| 蓝牙SPP | 每事务单次最多400ms；查询、动作、失能均不自动重发整批响应 |
| 连接与写入 | 建立蓝牙链路最多8s、整帧写入最多50ms；连接中可取消 |
| 蓝牙非遥控轮询 | 九状态查询最短400ms，详细四轮最短1s |
| 蓝牙遥控轮询 | 底盘状态与最新速度交替；详细四轮查询暂缓 |
| 心跳 | 合法请求已刷新固件链路计时；持续状态/速度不另堆心跳，空闲100ms才发 |
| 遥控输入/输出 | 输入新鲜期限250ms；速度最新值单槽，最快每100ms一次 |
| 反馈与使能确认 | 状态600ms过期；遥控底盘反馈/使能确认仍为600ms |
| 下位机门禁 | ≥500ms无有效请求撤销运行授权，未因蓝牙延迟适配而延长 |

不以新序号自动补发不确定动作。蓝牙过期会撤销会话、清旧速度/队列、关闭链路，并报告序号、操作码、已收/期望与缺失设备；迟到应答不能恢复控制。400ms只是PC等待预算，不能以400<500推导无线链路始终及时送达。弱链路应排查供电/干扰或改USB串口，不继续放宽保护。

### 浏览器间歇超时修复的范围

连接专属20ms内联Worker避免Window后台计时节流，只用于浏览器版。桌面的150ms截止、心跳和轮询已迁至Rust独立线程，不依赖WebView定时器。断开、失败或重新握手会终止旧Worker并释放Blob URL，旧会话回调不能发包；失败后需人工重新握手，不自动重连、使能或恢复旧目标。

整页/主线程冻结、系统休眠、进程停止、USB断开和真实无线故障仍可能触发500ms保护；PC不提供硬实时或物理安全保证。串口LinkFault结果107与真正CAN反馈离线结果1分开判断，新心跳不恢复使能或旧目标；恢复操作见[USAGE](USAGE.md)。

Ozone为独立桌面TCP调试通道，不增加串口操作码、固件邮箱或暂存区。切页保留原通信与失联门禁，但RAM直接写入绕过设备接口安全校验，风险与字段说明见[OZONE](OZONE.md)。
