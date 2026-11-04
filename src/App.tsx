import * as React from 'react';
import { useAtom } from 'jotai';
import {
  Activity,
  Zap,
  Power,
  RotateCcw,
  Square,
  Sliders,
  SlidersHorizontal,
  Terminal,
  RefreshCw,
  Download,
  Trash2,
  Pause,
  Play,
  Layers,
  Cpu,
  Radio,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Compass,
  Gauge,
  Workflow,
  Copy,
  ChevronRight,
} from 'lucide-react';

import {
  platformInfoAtom,
  serialPortsAtom,
  selectedPortAtom,
  baudRateAtom,
  connectionStatusAtom,
  commStatsAtom,
  motorStatesAtom,
  selectedMotorCanIdAtom,
  draftTargetDegAtom,
  stepDeltaDegAtom,
  draftLimitsAtom,
  scopeConfigAtom,
  logsAtom,
  pauseLogScrollAtom,
  logFilterAtom,
  type LogEntry,
  type LogLevel,
  type MotorRuntimeState,
} from './store/atoms';

import {
  MOTORS,
  MOTOR_MAP,
  BROADCAST_MOTOR_ID,
  Opcode,
  OpcodeNames,
  ResultCode,
  ResultNames,
  MotorStateNames,
  OzoneCommandNames,
  bytesToHex,
  type DecodedResponse,
  type StatePayload,
  type ParametersPayload,
} from './lib/protocol';

import {
  TransportManager,
  getPlatformInfo,
  listNativeSerialPorts,
} from './lib/transport';

import { Card, CardHeader, CardTitle, CardContent } from './components/ui/card';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import {
  OscilloscopeCanvas,
  type OscilloscopeHandle,
} from './components/OscilloscopeCanvas';

type MainTab = 'scope' | 'control' | 'params' | 'bus';

export function App() {
  const [platformInfo, setPlatformInfo] = useAtom(platformInfoAtom);
  const [serialPorts, setSerialPorts] = useAtom(serialPortsAtom);
  const [selectedPort, setSelectedPort] = useAtom(selectedPortAtom);
  const [baudRate, setBaudRate] = useAtom(baudRateAtom);
  const [connStatus, setConnStatus] = useAtom(connectionStatusAtom);
  const [commStats, setCommStats] = useAtom(commStatsAtom);

  const [motorStates, setMotorStates] = useAtom(motorStatesAtom);
  const [selectedMotorCanId, setSelectedMotorCanId] = useAtom(selectedMotorCanIdAtom);

  const [draftTargetDeg, setDraftTargetDeg] = useAtom(draftTargetDegAtom);
  const [stepDeltaDeg, setStepDeltaDeg] = useAtom(stepDeltaDegAtom);
  const [draftLimits, setDraftLimits] = useAtom(draftLimitsAtom);

  const [scopeConfig, setScopeConfig] = useAtom(scopeConfigAtom);
  const [logs, setLogs] = useAtom(logsAtom);
  const [pauseLogScroll, setPauseLogScroll] = useAtom(pauseLogScrollAtom);
  const [logFilter, setLogFilter] = useAtom(logFilterAtom);

  const [activeTab, setActiveTab] = React.useState<MainTab>('scope');
  const [showZeroConfirmModal, setShowZeroConfirmModal] = React.useState(false);
  const [copyFeedback, setCopyFeedback] = React.useState<string | null>(null);

  const scopeRef = React.useRef<OscilloscopeHandle | null>(null);
  const logContainerRef = React.useRef<HTMLDivElement | null>(null);
  const transportRef = React.useRef<TransportManager | null>(null);

  // 初始化平台检测与原生串口列表
  React.useEffect(() => {
    getPlatformInfo().then((info) => {
      setPlatformInfo(info);
      if (info.isTauri) {
        listNativeSerialPorts().then((ports) => {
          setSerialPorts(ports);
          if (ports.length > 0 && !selectedPort) {
            setSelectedPort(ports[0].portName);
          }
        });
      }
    });
  }, []);

  // 传输引擎实例化与回调桥接
  React.useEffect(() => {
    const tm = new TransportManager({
      onLog: (level: LogLevel, msg: string, rawHex?: string) => {
        const time = new Date().toLocaleTimeString('zh-CN', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          fractionalSecondDigits: 3,
        });
        const id = Math.random().toString(36).substring(2, 9);
        setLogs((prev) => {
          const next = [...prev, { id, time, level, message: msg, rawHex }];
          return next.length > 500 ? next.slice(-500) : next;
        });
      },
      onFrameDecoded: (frame: DecodedResponse) => {
        // 更新下位机电机运行状态
        if (frame.opcode === Opcode.State && 'flags' in frame) {
          const st = frame as StatePayload;
          setMotorStates((prev) => {
            const current = prev[st.motor];
            if (!current) return prev;
            return {
              ...prev,
              [st.motor]: {
                ...current,
                state: st,
                lastUpdated: Date.now(),
              },
            };
          });

          // 如果是当前正在监视的电机，推送示波器点
          if (st.motor === selectedMotorCanId && scopeRef.current) {
            scopeRef.current.pushPoint({
              time: performance.now(),
              positionDeg: st.positionDeg,
              referenceDeg: st.referenceDeg,
              velocityRpm: st.velocityRpm,
              velocityRefRpm: st.referenceVelocityDegS / 6.0,
              torqueNm: st.torqueNm,
              torqueFfNm: st.commandedTorqueFfNm,
            });
          }
        } else if (frame.opcode === Opcode.Parameters && 'minDeg' in frame) {
          const p = frame as ParametersPayload;
          setMotorStates((prev) => {
            const current = prev[p.motor];
            if (!current) return prev;
            return {
              ...prev,
              [p.motor]: {
                ...current,
                params: p,
                lastUpdated: Date.now(),
              },
            };
          });
        }
      },
      onStatsTx: () => {
        setCommStats((s) => ({ ...s, txFrames: s.txFrames + 1 }));
      },
      onStatsRx: () => {
        setCommStats((s) => ({ ...s, rxFrames: s.rxFrames + 1 }));
      },
      onStatsCrcError: () => {
        setCommStats((s) => ({ ...s, crcErrors: s.crcErrors + 1 }));
      },
      onStatsTimeout: () => {
        setCommStats((s) => ({ ...s, timeouts: s.timeouts + 1 }));
      },
      onConnectionChange: (connected, mode) => {
        setConnStatus((prev) => ({
          ...prev,
          connected,
          connecting: false,
          mode,
        }));
      },
    });

    transportRef.current = tm;

    // 默认自动连接仿真器以提供零等待开箱即用体验
    tm.connectSimulator().catch(() => {});

    return () => {
      tm.disconnect().catch(() => {});
    };
  }, [selectedMotorCanId]);

  // 自动滚动日志窗口
  React.useEffect(() => {
    if (!pauseLogScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, pauseLogScroll]);

  // 切换操作电机时，同步预填控制面板限位与目标值
  const currentMotorRuntime = motorStates[selectedMotorCanId];
  const currentMotorConfig = MOTOR_MAP.get(selectedMotorCanId) || MOTORS[0];

  React.useEffect(() => {
    if (currentMotorRuntime?.state) {
      setDraftTargetDeg(Number(currentMotorRuntime.state.positionDeg.toFixed(2)));
    }
    if (currentMotorRuntime?.params) {
      setDraftLimits({
        minDeg: currentMotorRuntime.params.minDeg,
        maxDeg: currentMotorRuntime.params.maxDeg,
        maxVelocityDegS: currentMotorRuntime.params.maxVelocityDegS,
        maxAccelerationDegS2: currentMotorRuntime.params.maxAccelerationDegS2,
        maxJerkDegS3: currentMotorRuntime.params.maxJerkDegS3,
      });
    }
  }, [selectedMotorCanId]);

  // 串口连接与断开处理
  const handleToggleConnect = async () => {
    const tm = transportRef.current;
    if (!tm) return;

    if (connStatus.connected) {
      await tm.disconnect();
    } else {
      setConnStatus((prev) => ({ ...prev, connecting: true }));
      try {
        if (connStatus.mode === 'simulator') {
          await tm.connectSimulator();
        } else if (connStatus.mode === 'tauri') {
          if (!selectedPort) throw new Error('请先选择串口');
          await tm.connectTauri(selectedPort, baudRate);
        } else if (connStatus.mode === 'web-serial') {
          await tm.connectWebSerial(baudRate);
        }
      } catch (err) {
        setConnStatus((prev) => ({ ...prev, connecting: false }));
        alert(`连接失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const handleRefreshPorts = async () => {
    if (platformInfo.isTauri) {
      const ports = await listNativeSerialPorts();
      setSerialPorts(ports);
      if (ports.length > 0 && !selectedPort) {
        setSelectedPort(ports[0].portName);
      }
    }
  };

  // 控制动作
  const handleEnable = async (motorId: number) => {
    try {
      await transportRef.current?.enableMotor(motorId);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDisable = async (motorId: number) => {
    try {
      await transportRef.current?.disableMotor(motorId);
    } catch (e) {
      console.error(e);
    }
  };

  const handleStop = async (motorId: number) => {
    try {
      await transportRef.current?.stopMotor(motorId);
    } catch (e) {
      console.error(e);
    }
  };

  const handleMove = async () => {
    if (!currentMotorRuntime?.state?.flags.enabled) {
      alert('请先使能电机');
      return;
    }
    try {
      await transportRef.current?.moveMotor(selectedMotorCanId, draftTargetDeg);
    } catch (e) {
      console.error(e);
    }
  };

  const handleConfirmSetZero = async () => {
    setShowZeroConfirmModal(false);
    try {
      await transportRef.current?.setZero(selectedMotorCanId);
      // 成功后按协议要求主动查询状态与参数
      await transportRef.current?.queryState(selectedMotorCanId);
      await transportRef.current?.queryParameters(selectedMotorCanId);
    } catch (e) {
      console.error(e);
    }
  };

  const handleApplyLimits = async () => {
    if (draftLimits.minDeg >= draftLimits.maxDeg) {
      alert('最小角度必须小于最大角度');
      return;
    }
    if (
      draftLimits.maxVelocityDegS <= 0 ||
      draftLimits.maxAccelerationDegS2 <= 0 ||
      draftLimits.maxJerkDegS3 <= 0
    ) {
      alert('速度、加速度与加加速度上限必须大于 0');
      return;
    }
    try {
      await transportRef.current?.setLimits(selectedMotorCanId, draftLimits);
      await transportRef.current?.queryParameters(selectedMotorCanId);
    } catch (e) {
      console.error(e);
    }
  };

  const handleQueryParameters = async (motorId: number) => {
    try {
      await transportRef.current?.queryParameters(motorId);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCopyHex = (hex: string) => {
    navigator.clipboard.writeText(hex);
    setCopyFeedback(hex);
    setTimeout(() => setCopyFeedback(null), 1500);
  };

  const filteredLogs = logs.filter((log) => {
    if (logFilter === 'tx') return log.level === 'tx';
    if (logFilter === 'rx') return log.level === 'rx';
    if (logFilter === 'warn-error') return log.level === 'warn' || log.level === 'error';
    return true;
  });

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-slate-50 text-slate-900 select-none">
      {/* 1. 顶部全局仪器工具栏 (56px) */}
      <header className="h-14 border-b border-slate-200 bg-white px-4 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-sky-600 flex items-center justify-center text-white font-mono font-bold text-sm">
            DM
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold tracking-tight text-slate-900">
                DMDebug Station
              </h1>
              <span className="text-[11px] text-slate-500 font-mono">
                USART1 115200 8N1
              </span>
            </div>
            <p className="text-[11px] text-slate-500">
              六轴达妙电机运动测控与遥测工作台
            </p>
          </div>
        </div>

        {/* 连接与物理接口选择 */}
        <div className="flex items-center gap-3">
          {/* 通信模式选择 */}
          <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs">
            <button
              onClick={() => {
                if (connStatus.mode !== 'simulator') {
                  setConnStatus((prev) => ({ ...prev, mode: 'simulator' }));
                }
              }}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                connStatus.mode === 'simulator'
                  ? 'bg-white font-medium text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              仿真器
            </button>
            {platformInfo.isTauri && (
              <button
                onClick={() => {
                  if (connStatus.mode !== 'tauri') {
                    setConnStatus((prev) => ({ ...prev, mode: 'tauri' }));
                  }
                }}
                className={`px-2.5 py-1 rounded-md transition-colors ${
                  connStatus.mode === 'tauri'
                    ? 'bg-white font-medium text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                原生串口
              </button>
            )}
            {platformInfo.hasWebSerial && (
              <button
                onClick={() => {
                  if (connStatus.mode !== 'web-serial') {
                    setConnStatus((prev) => ({ ...prev, mode: 'web-serial' }));
                  }
                }}
                className={`px-2.5 py-1 rounded-md transition-colors ${
                  connStatus.mode === 'web-serial'
                    ? 'bg-white font-medium text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Web 串口
              </button>
            )}
          </div>

          {/* 端口与波特率选择器 */}
          {connStatus.mode === 'tauri' && (
            <div className="flex items-center gap-2">
              <select
                value={selectedPort}
                onChange={(e) => setSelectedPort(e.target.value)}
                disabled={connStatus.connected}
                className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700 outline-none focus:border-sky-500"
              >
                {serialPorts.length === 0 && <option value="">未检测到串口</option>}
                {serialPorts.map((p) => (
                  <option key={p.portName} value={p.portName}>
                    {p.portName} {p.product ? `(${p.product})` : ''}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshPorts}
                disabled={connStatus.connected}
                title="刷新串口列表"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          <select
            value={baudRate}
            onChange={(e) => setBaudRate(Number(e.target.value))}
            disabled={connStatus.connected || connStatus.mode === 'simulator'}
            className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 font-mono outline-none focus:border-sky-500"
          >
            <option value={115200}>115200</option>
            <option value={921600}>921600</option>
          </select>

          {/* 连接/断开主控按钮 */}
          <Button
            variant={connStatus.connected ? 'destructive' : 'default'}
            size="sm"
            onClick={handleToggleConnect}
            className="min-w-[76px]"
          >
            <Power className="h-3.5 w-3.5" />
            {connStatus.connected ? '断开' : '连接'}
          </Button>

          {/* 状态徽标与统计指标 */}
          <div className="h-6 w-px bg-slate-200" />

          <div className="flex items-center gap-4 text-xs font-mono tnum text-slate-600">
            <div className="flex items-center gap-1.5">
              <span
                className={`h-2 w-2 rounded-full ${
                  connStatus.connected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'
                }`}
              />
              <span className="text-slate-800 font-medium">
                {connStatus.connected
                  ? connStatus.mode === 'simulator'
                    ? '仿真在线'
                    : '硬件在线'
                  : '未连接'}
              </span>
            </div>

            <div className="flex items-center gap-3 text-slate-500 text-[11px]">
              <span>TX: {commStats.txFrames}</span>
              <span>RX: {commStats.rxFrames}</span>
              {commStats.timeouts > 0 && (
                <span className="text-amber-600 font-medium">
                  超时: {commStats.timeouts}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* 2. 主工作区：左侧六电机概览阵列 + 右侧测控主视图 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧：六电机状态矩阵栏 (280px) */}
        <aside className="w-[300px] border-r border-slate-200 bg-slate-50/70 flex flex-col shrink-0 overflow-hidden">
          <div className="p-3 border-b border-slate-200 flex items-center justify-between bg-white shrink-0">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
              <Layers className="h-4 w-4 text-sky-600" />
              <span>六电机状态矩阵</span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => transportRef.current?.queryState(BROADCAST_MOTOR_ID)}
                title="广播查询全部六电机状态"
              >
                <RefreshCw className="h-3 w-3" />
              </Button>
            </div>
          </div>

          {/* 六电机列表 */}
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {MOTORS.map((m) => {
              const run = motorStates[m.canId];
              const st = run?.state;
              const isSelected = selectedMotorCanId === m.canId;
              const isEnabled = st?.flags.enabled ?? false;
              const isFault = st?.flags.fault ?? false;
              const isBusy = st?.flags.busy ?? false;
              const pos = st ? st.positionDeg : 0.0;
              const minDeg = run?.params ? run.params.minDeg : m.initialMinDeg;
              const maxDeg = run?.params ? run.params.maxDeg : m.initialMaxDeg;
              const rangeSpan = Math.max(1, maxDeg - minDeg);
              const progressPct = Math.min(
                100,
                Math.max(0, ((pos - minDeg) / rangeSpan) * 100)
              );

              return (
                <div
                  key={m.canId}
                  onClick={() => setSelectedMotorCanId(m.canId)}
                  className={`p-2.5 rounded-xl border text-xs cursor-pointer transition-all ${
                    isSelected
                      ? 'border-sky-500 bg-white shadow-xs ring-1 ring-sky-500/20'
                      : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/80'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-semibold text-slate-800">
                        0x{m.canId.toString(16).toUpperCase().padStart(2, '0')}
                      </span>
                      <span className="font-medium text-slate-900">{m.name}</span>
                    </div>
                    <span className="text-[11px] font-mono text-slate-400">
                      {m.model}
                    </span>
                  </div>

                  {/* 状态徽标行 */}
                  <div className="flex items-center gap-1.5 mb-2">
                    <Badge variant={isEnabled ? 'success' : 'neutral'}>
                      {isEnabled ? '已使能' : '已失能'}
                    </Badge>
                    {isBusy && <Badge variant="warning">运动中</Badge>}
                    {isFault && <Badge variant="destructive">故障</Badge>}
                    {st?.flags.motionComplete && !isBusy && isEnabled && (
                      <Badge variant="default">到位</Badge>
                    )}
                  </div>

                  {/* 实时物理角度与行程进度条 */}
                  <div className="space-y-1">
                    <div className="flex justify-between items-baseline font-mono text-[11px]">
                      <span className="text-slate-500">当前位置</span>
                      <span className="font-semibold text-slate-900 text-xs tabular-nums">
                        {pos.toFixed(2)}°
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-150 ${
                          isEnabled ? 'bg-sky-500' : 'bg-slate-300'
                        }`}
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] font-mono text-slate-400">
                      <span>{minDeg}°</span>
                      <span>{maxDeg}°</span>
                    </div>
                  </div>

                  {/* 快捷单轴使能/失能/急停按钮 */}
                  <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between gap-1">
                    {isEnabled ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDisable(m.canId);
                        }}
                        className="px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200 text-[11px] font-medium"
                      >
                        失能
                      </button>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEnable(m.canId);
                        }}
                        className="px-2 py-1 rounded bg-sky-50 text-sky-700 hover:bg-sky-100 text-[11px] font-medium"
                      >
                        使能
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStop(m.canId);
                      }}
                      disabled={!isEnabled}
                      className="px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200 text-[11px] font-medium disabled:opacity-40"
                    >
                      急停
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 底部广播操作快捷面板 */}
          <div className="p-3 border-t border-slate-200 bg-white shrink-0 space-y-2">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              全局多轴命令 (广播 0xFF)
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => transportRef.current?.disableMotor(BROADCAST_MOTOR_ID)}
                className="w-full text-slate-700"
              >
                全轴失能
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => transportRef.current?.stopMotor(BROADCAST_MOTOR_ID)}
                className="w-full"
              >
                全轴急停
              </Button>
            </div>
          </div>
        </aside>

        {/* 右侧：单轴控制中心与功能选项卡 */}
        <main className="flex-1 flex flex-col overflow-hidden bg-slate-50">
          {/* 单轴标题与关键参数指示栏 */}
          <div className="h-14 border-b border-slate-200 bg-white px-5 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <div className="font-mono text-sm font-bold text-sky-700 bg-sky-50 border border-sky-200 px-2.5 py-1 rounded-lg">
                CAN 0x{currentMotorConfig.canId.toString(16).toUpperCase()}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-slate-900">
                    {currentMotorConfig.name}
                  </h2>
                  <span className="text-xs text-slate-500">
                    ({currentMotorConfig.model}，Master: 0x
                    {currentMotorConfig.masterId.toString(16).toUpperCase()})
                  </span>
                </div>
              </div>
            </div>

            {/* 功能选项卡切换 */}
            <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs">
              <button
                onClick={() => setActiveTab('scope')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                  activeTab === 'scope'
                    ? 'bg-white font-medium text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Activity className="h-3.5 w-3.5 text-sky-600" />
                遥测示波器
              </button>
              <button
                onClick={() => setActiveTab('control')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                  activeTab === 'control'
                    ? 'bg-white font-medium text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Compass className="h-3.5 w-3.5 text-emerald-600" />
                运动控制与标定
              </button>
              <button
                onClick={() => {
                  setActiveTab('params');
                  handleQueryParameters(selectedMotorCanId);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                  activeTab === 'params'
                    ? 'bg-white font-medium text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Sliders className="h-3.5 w-3.5 text-amber-600" />
                动力学限位
              </button>
              <button
                onClick={() => setActiveTab('bus')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                  activeTab === 'bus'
                    ? 'bg-white font-medium text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Terminal className="h-3.5 w-3.5 text-slate-600" />
                总线报文监视
              </button>
            </div>
          </div>

          {/* 主展示区 */}
          <div className="flex-1 p-4 overflow-y-auto">
            {/* 选项卡 1: 实时遥测示波器 */}
            {activeTab === 'scope' && (
              <div className="h-full flex flex-col space-y-3">
                {/* 示波器控制器栏 */}
                <div className="flex items-center justify-between bg-white p-3 rounded-xl border border-slate-200">
                  <div className="flex items-center gap-4 text-xs">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={scopeConfig.showPosition}
                        onChange={(e) =>
                          setScopeConfig((s) => ({ ...s, showPosition: e.target.checked }))
                        }
                        className="rounded border-slate-300 text-sky-600 focus:ring-0"
                      />
                      <span className="h-2 w-2 rounded-full bg-sky-600" />
                      <span className="font-medium text-slate-800">位置角度 (°)</span>
                    </label>

                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={scopeConfig.showVelocity}
                        onChange={(e) =>
                          setScopeConfig((s) => ({ ...s, showVelocity: e.target.checked }))
                        }
                        className="rounded border-slate-300 text-emerald-600 focus:ring-0"
                      />
                      <span className="h-2 w-2 rounded-full bg-emerald-600" />
                      <span className="font-medium text-slate-800">转速 (rpm)</span>
                    </label>

                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={scopeConfig.showTorque}
                        onChange={(e) =>
                          setScopeConfig((s) => ({ ...s, showTorque: e.target.checked }))
                        }
                        className="rounded border-slate-300 text-amber-600 focus:ring-0"
                      />
                      <span className="h-2 w-2 rounded-full bg-amber-600" />
                      <span className="font-medium text-slate-800">力矩 (Nm)</span>
                    </label>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setScopeConfig((s) => ({ ...s, isPaused: !s.isPaused }))
                      }
                    >
                      {scopeConfig.isPaused ? (
                        <>
                          <Play className="h-3.5 w-3.5 text-emerald-600" />
                          继续
                        </>
                      ) : (
                        <>
                          <Pause className="h-3.5 w-3.5" />
                          暂停
                        </>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => scopeRef.current?.clear()}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      清空波形
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const csv = scopeRef.current?.exportCsv();
                        if (csv) {
                          const blob = new Blob([csv], { type: 'text/csv' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `dm_telemetry_0x${selectedMotorCanId.toString(16)}_${Date.now()}.csv`;
                          a.click();
                        }
                      }}
                    >
                      <Download className="h-3.5 w-3.5" />
                      导出 CSV
                    </Button>
                  </div>
                </div>

                {/* 示波器画布容器 */}
                <div className="flex-1 min-h-[360px] bg-white rounded-xl border border-slate-200 p-2 overflow-hidden shadow-2xs">
                  <OscilloscopeCanvas
                    ref={scopeRef}
                    isPaused={scopeConfig.isPaused}
                    showPosition={scopeConfig.showPosition}
                    showVelocity={scopeConfig.showVelocity}
                    showTorque={scopeConfig.showTorque}
                    motorName={currentMotorConfig.name}
                  />
                </div>
              </div>
            )}

            {/* 选项卡 2: 运动控制与标定 */}
            {activeTab === 'control' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* 位置设定与绝对运动 */}
                <Card>
                  <CardHeader>
                    <CardTitle>
                      <Compass className="h-4 w-4 text-sky-600" />
                      位置伺服运动 (Move, Opcode 0x24)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <div className="flex justify-between items-baseline mb-1">
                        <span className="text-xs text-slate-500">目标位置 (绝对角度)</span>
                        <span className="font-mono text-base font-bold text-sky-700">
                          {draftTargetDeg.toFixed(2)}°
                        </span>
                      </div>
                      <input
                        type="range"
                        min={currentMotorConfig.initialMinDeg}
                        max={currentMotorConfig.initialMaxDeg}
                        step={0.1}
                        value={draftTargetDeg}
                        onChange={(e) => setDraftTargetDeg(Number(e.target.value))}
                        className="w-full studio-fader"
                      />
                      <div className="flex justify-between text-[11px] font-mono text-slate-400 mt-1">
                        <span>{currentMotorConfig.initialMinDeg}°</span>
                        <span>0°</span>
                        <span>{currentMotorConfig.initialMaxDeg}°</span>
                      </div>
                    </div>

                    {/* 微调步进预设 */}
                    <div>
                      <span className="text-xs text-slate-500 block mb-1.5">步进增减</span>
                      <div className="flex flex-wrap gap-2">
                        {[-5.0, -1.0, -0.2, 0.2, 1.0, 5.0].map((step) => (
                          <Button
                            key={step}
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              const next = Number((draftTargetDeg + step).toFixed(2));
                              if (
                                next >= currentMotorConfig.initialMinDeg &&
                                next <= currentMotorConfig.initialMaxDeg
                              ) {
                                setDraftTargetDeg(next);
                              }
                            }}
                          >
                            {step > 0 ? `+${step}` : step}°
                          </Button>
                        ))}
                      </div>
                    </div>

                    <div className="pt-2 flex items-center gap-2">
                      <Button
                        variant="default"
                        onClick={handleMove}
                        disabled={!currentMotorRuntime?.state?.flags.enabled}
                        className="flex-1"
                      >
                        执行绝对运动 (Move)
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => handleStop(selectedMotorCanId)}
                      >
                        停止 (Stop)
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {/* 软件归零与校准 */}
                <Card>
                  <CardHeader>
                    <CardTitle>
                      <RotateCcw className="h-4 w-4 text-emerald-600" />
                      软件归零校准 (SetZero, Opcode 0x23)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-xs text-slate-600 leading-relaxed">
                      将当前电机反馈位置校准为软件零点坐标（0.0°）。已有运动限位将自动平移以保持物理工作区不变。
                    </p>

                    <div className="p-3 bg-amber-50 border border-amber-200/80 rounded-lg text-xs text-amber-900 space-y-1">
                      <div className="flex items-center gap-1.5 font-medium">
                        <AlertTriangle className="h-4 w-4 text-amber-600" />
                        安全注意事项
                      </div>
                      <p className="text-[11px] leading-normal">
                        根据下位机协议，归零仅允许在电机已失能、静止且稳定的状态下执行。执行后旧目标位置将失效。
                      </p>
                    </div>

                    <div className="pt-2">
                      <Button
                        variant="outline"
                        onClick={() => setShowZeroConfirmModal(true)}
                        disabled={currentMotorRuntime?.state?.flags.enabled}
                        className="w-full"
                      >
                        校准当前点为软件零点 (SetZero)
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* 选项卡 3: 动力学限位与控制参数 */}
            {activeTab === 'params' && (
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>
                      <SlidersHorizontal className="h-4 w-4 text-amber-600" />
                      已应用限位与动力学配置 (Parameters, Opcode 0x11 / 0x25)
                    </CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleQueryParameters(selectedMotorCanId)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      刷新已应用参数
                    </Button>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      <div>
                        <label className="text-xs font-medium text-slate-600 block mb-1">
                          最小行程限位 (min_deg, °)
                        </label>
                        <input
                          type="number"
                          value={draftLimits.minDeg}
                          onChange={(e) =>
                            setDraftLimits((l) => ({ ...l, minDeg: Number(e.target.value) }))
                          }
                          disabled={currentMotorRuntime?.state?.flags.enabled}
                          className="h-8 w-full rounded-lg border border-slate-200 px-2.5 text-xs font-mono tabular-nums outline-none focus:border-sky-500 disabled:bg-slate-100"
                        />
                      </div>

                      <div>
                        <label className="text-xs font-medium text-slate-600 block mb-1">
                          最大行程限位 (max_deg, °)
                        </label>
                        <input
                          type="number"
                          value={draftLimits.maxDeg}
                          onChange={(e) =>
                            setDraftLimits((l) => ({ ...l, maxDeg: Number(e.target.value) }))
                          }
                          disabled={currentMotorRuntime?.state?.flags.enabled}
                          className="h-8 w-full rounded-lg border border-slate-200 px-2.5 text-xs font-mono tabular-nums outline-none focus:border-sky-500 disabled:bg-slate-100"
                        />
                      </div>

                      <div>
                        <label className="text-xs font-medium text-slate-600 block mb-1">
                          轨迹速度上限 (max_velocity, deg/s)
                        </label>
                        <input
                          type="number"
                          value={draftLimits.maxVelocityDegS}
                          onChange={(e) =>
                            setDraftLimits((l) => ({
                              ...l,
                              maxVelocityDegS: Number(e.target.value),
                            }))
                          }
                          disabled={currentMotorRuntime?.state?.flags.enabled}
                          className="h-8 w-full rounded-lg border border-slate-200 px-2.5 text-xs font-mono tabular-nums outline-none focus:border-sky-500 disabled:bg-slate-100"
                        />
                      </div>

                      <div>
                        <label className="text-xs font-medium text-slate-600 block mb-1">
                          加速度上限 (max_acceleration, deg/s²)
                        </label>
                        <input
                          type="number"
                          value={draftLimits.maxAccelerationDegS2}
                          onChange={(e) =>
                            setDraftLimits((l) => ({
                              ...l,
                              maxAccelerationDegS2: Number(e.target.value),
                            }))
                          }
                          disabled={currentMotorRuntime?.state?.flags.enabled}
                          className="h-8 w-full rounded-lg border border-slate-200 px-2.5 text-xs font-mono tabular-nums outline-none focus:border-sky-500 disabled:bg-slate-100"
                        />
                      </div>

                      <div>
                        <label className="text-xs font-medium text-slate-600 block mb-1">
                          加加速度上限 (max_jerk, deg/s³)
                        </label>
                        <input
                          type="number"
                          value={draftLimits.maxJerkDegS3}
                          onChange={(e) =>
                            setDraftLimits((l) => ({
                              ...l,
                              maxJerkDegS3: Number(e.target.value),
                            }))
                          }
                          disabled={currentMotorRuntime?.state?.flags.enabled}
                          className="h-8 w-full rounded-lg border border-slate-200 px-2.5 text-xs font-mono tabular-nums outline-none focus:border-sky-500 disabled:bg-slate-100"
                        />
                      </div>
                    </div>

                    <div className="mt-4 pt-4 border-t border-slate-100 flex justify-end">
                      <Button
                        variant="default"
                        onClick={handleApplyLimits}
                        disabled={currentMotorRuntime?.state?.flags.enabled}
                      >
                        下发动力学限位 (SetLimits)
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {/* 只读控制参数详情 */}
                {currentMotorRuntime?.params && (
                  <Card>
                    <CardHeader>
                      <CardTitle>底层闭环控制只读参数 (RAM 快照)</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 text-xs font-mono">
                        <div className="p-2.5 bg-slate-50 rounded-lg">
                          <span className="text-slate-500 block text-[11px]">Kp 刚度</span>
                          <span className="font-semibold text-slate-800">
                            {currentMotorRuntime.params.kp.toFixed(2)}
                          </span>
                        </div>
                        <div className="p-2.5 bg-slate-50 rounded-lg">
                          <span className="text-slate-500 block text-[11px]">Kd 阻尼</span>
                          <span className="font-semibold text-slate-800">
                            {currentMotorRuntime.params.kd.toFixed(2)}
                          </span>
                        </div>
                        <div className="p-2.5 bg-slate-50 rounded-lg">
                          <span className="text-slate-500 block text-[11px]">力矩前馈</span>
                          <span className="font-semibold text-slate-800">
                            {currentMotorRuntime.params.torqueFfNm.toFixed(2)} Nm
                          </span>
                        </div>
                        <div className="p-2.5 bg-slate-50 rounded-lg">
                          <span className="text-slate-500 block text-[11px]">到位容差</span>
                          <span className="font-semibold text-slate-800">
                            {currentMotorRuntime.params.finishDeg.toFixed(2)}°
                          </span>
                        </div>
                        <div className="p-2.5 bg-slate-50 rounded-lg">
                          <span className="text-slate-500 block text-[11px]">静止阈值</span>
                          <span className="font-semibold text-slate-800">
                            {currentMotorRuntime.params.stationaryRpm.toFixed(2)} rpm
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            {/* 选项卡 4: 总线报文监视 */}
            {activeTab === 'bus' && (
              <div className="h-full flex flex-col space-y-2">
                <div className="flex items-center justify-between bg-white p-2.5 rounded-xl border border-slate-200">
                  <div className="flex items-center gap-1.5 text-xs">
                    <button
                      onClick={() => setLogFilter('all')}
                      className={`px-2.5 py-1 rounded-md transition-colors ${
                        logFilter === 'all'
                          ? 'bg-slate-100 font-semibold text-slate-900'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      全部报文 ({logs.length})
                    </button>
                    <button
                      onClick={() => setLogFilter('tx')}
                      className={`px-2.5 py-1 rounded-md transition-colors ${
                        logFilter === 'tx'
                          ? 'bg-sky-50 font-semibold text-sky-700'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      仅 TX 发送
                    </button>
                    <button
                      onClick={() => setLogFilter('rx')}
                      className={`px-2.5 py-1 rounded-md transition-colors ${
                        logFilter === 'rx'
                          ? 'bg-emerald-50 font-semibold text-emerald-700'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      仅 RX 接收
                    </button>
                    <button
                      onClick={() => setLogFilter('warn-error')}
                      className={`px-2.5 py-1 rounded-md transition-colors ${
                        logFilter === 'warn-error'
                          ? 'bg-red-50 font-semibold text-red-700'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      警告与错误
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPauseLogScroll(!pauseLogScroll)}
                    >
                      {pauseLogScroll ? '恢复滚动' : '暂停滚动'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setLogs([])}
                    >
                      清空日志
                    </Button>
                  </div>
                </div>

                {/* 报文条目列表 */}
                <div
                  ref={logContainerRef}
                  className="flex-1 bg-white rounded-xl border border-slate-200 p-3 font-mono text-[11px] overflow-y-auto space-y-1.5 shadow-2xs"
                >
                  {filteredLogs.length === 0 && (
                    <div className="text-center text-slate-400 py-12">暂无报文记录</div>
                  )}
                  {filteredLogs.map((entry) => (
                    <div
                      key={entry.id}
                      className="p-1.5 rounded hover:bg-slate-50 transition-colors flex items-start gap-2 border-b border-slate-100 last:border-0"
                    >
                      <span className="text-slate-400 shrink-0 select-none">
                        {entry.time}
                      </span>
                      <span
                        className={`font-semibold shrink-0 uppercase ${
                          entry.level === 'tx'
                            ? 'text-sky-600'
                            : entry.level === 'rx'
                            ? 'text-emerald-600'
                            : entry.level === 'warn'
                            ? 'text-amber-600'
                            : 'text-red-600'
                        }`}
                      >
                        [{entry.level}]
                      </span>
                      <div className="flex-1 overflow-hidden">
                        <div className="text-slate-800 break-words">
                          {entry.message}
                        </div>
                        {entry.rawHex && (
                          <div className="flex items-center gap-2 mt-0.5 text-slate-500 font-mono text-[10px] break-all bg-slate-50 p-1 rounded">
                            <span className="flex-1">{entry.rawHex}</span>
                            <button
                              onClick={() => handleCopyHex(entry.rawHex!)}
                              className="text-slate-400 hover:text-slate-700"
                              title="复制原始 64 字节十六进制"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* 3. 软件归零二次确认弹窗 */}
      {showZeroConfirmModal && (
        <div className="fixed inset-0 bg-slate-900/30 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-5 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center gap-3 text-amber-600">
              <AlertTriangle className="h-6 w-6 shrink-0" />
              <h3 className="text-sm font-semibold text-slate-900">
                确认校准软件零点？
              </h3>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              确定将{' '}
              <span className="font-semibold text-slate-800">
                {currentMotorConfig.name} (CAN 0x
                {currentMotorConfig.canId.toString(16).toUpperCase()})
              </span>{' '}
              当前位置标记为软件坐标原点 (0.00°)？已有工作区限位将自动平移以保持同一物理范围。
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setShowZeroConfirmModal(false)}
              >
                取消
              </Button>
              <Button variant="default" onClick={handleConfirmSetZero}>
                确认校准
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
