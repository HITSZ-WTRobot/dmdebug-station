# 六轴达妙电机测控与调试上位机 (纯网页免安装独立版)

这是基于 **HTML5 + Web Serial API + 原生 Canvas** 开发的独立网页端串口调试上位机。

---

## 🌟 核心特性

- **零依赖与免安装**：无需安装任何 Node.js、Rust 或驱动环境，使用现代 Chromium 内核浏览器（Chrome、Edge 等）双击 `index.html`（或 `串口.html`）即可直接运行。
- **Web Serial API 原生直连**：浏览器直接调用操作系统底层串口驱动（支持 Windows `COMx`、macOS `/dev/cu.*`、Linux `/dev/ttyUSB*`）。
- **STM32 64 字节定长二进制协议**：完整支持 CRC16/CCITT-FALSE 校验与 `StreamUnpacker` 流式分包器，具备断包自动重组与噪点纠错能力。
- **60 FPS 实时三通道示波器**：支持输出轴角度、转速、力矩实时曲线滚屏、准星探针 HUD 测量与 CSV 历史数据一键导出。
- **六电机矩阵联动控制**：支持 0x0A ~ 0x0F 逐台独立使能/归零/S曲线运动/动力学限位，以及 0xFF 全局广播失能与急停。
- **内置电机物理仿真器 (Mock Simulator)**：离线或无硬件时一键启动 50Hz 动态电机阻尼与惯性运动响应仿真。

---

## 📁 目录结构

```text
web/
├── index.html        # 单文件便携版上位机（内嵌完整 CSS 与 JS，直接双击运行）
├── 串口.html         # 便携版中文同名入口
└── README.md         # 运行使用说明
```

---

## 🚀 运行方法

1. **直接双击** `web/index.html`（或 `web/串口.html`）；
2. 浏览器要求：Google Chrome $\ge 89$、Microsoft Edge $\ge 89$ 等支持 Web Serial API 的现代浏览器；
3. 点击顶部【连接串口】并在弹出的系统端口列表中选择 STM32 USB-TTL 串口即可开始测控；或点击【启动仿真器】进行零硬件免连接调试。
