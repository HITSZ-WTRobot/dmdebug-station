import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DEVICES, DEVICE_MAP, hexId } from '../lib/protocol';
import { isTauriEnvironment } from '../lib/transport';
import { exportTuningFile, finiteF32, parseTuningFile, tuningFields, updateSnapshotParameter, validateSnapshot, type OzoneParameter, type OzoneSnapshot } from '../lib/tuning';

// 草稿只属于当前页面会话，不自动写入控制器，也不会被读取覆盖。
const draftsByDevice = new Map<number, Record<string, string>>();
// 旧设备的断开先于新连接，避免切设备时旧请求污染新页或关闭新连接。
let ozoneQueue: Promise<void> = Promise.resolve();
function enqueueOzone<T>(action: () => Promise<T>): Promise<T> {
  const result = ozoneQueue.then(action);
  ozoneQueue = result.then(() => {}, () => {});
  return result;
}

export function OzoneTuningPage() {
  const [deviceId, setDeviceId] = useState(0x0a);
  return <main className="ozone-page">
    <div className="selection-heading"><div><div className="eyebrow">独立调试连接 · 固定符号目录</div><h1>Ozone调参</h1><p>直接修改实际控制器 RAM，不经串口命令、固件邮箱或 apply API。</p></div>
      <label className="field">调参设备<select value={deviceId} onChange={event => setDeviceId(Number(event.target.value))}>
        {DEVICES.filter(device => device.kind !== 'chassis').map(device => <option key={device.id} value={device.id}>{device.name} · {hexId(device.id)}</option>)}
      </select></label>
    </div>
    <p className="notice warning">直接写入不做参数范围、使能、静止、fault / busy 或串口就绪检查。增益跳变可能突变输出，不是无扰切换；不会清除 PID 积分或微分历史。单字段及配置镜像依次写入，并非原子事务；失败可能已部分修改，不回滚、不自动重试。请自行确保机械与动力安全。</p>
    <OzoneDevice key={deviceId} deviceId={deviceId} />
  </main>;
}

function OzoneDevice({ deviceId }: { deviceId: number }) {
  const definition = DEVICE_MAP.get(deviceId)!;
  const fields = tuningFields(definition);
  const desktop = isTauriEnvironment();
  const prefix = useId();
  const [drafts, setDrafts] = useState<Record<string, string>>(() => draftsByDevice.get(deviceId) ?? {});
  const [snapshot, setSnapshot] = useState<OzoneSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const transaction = useRef(false);
  const authorization = useRef(false);

  function revoke() { authorization.current = false; setAuthorized(false); }
  function active(token: number) { return mounted.current && epoch.current === token; }
  function requireActive(token: number) { if (!active(token)) throw new Error('设备或 Ozone 会话已切换，旧操作已撤销'); }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; epoch.current++; authorization.current = false;
      if (desktop) void enqueueOzone(() => invoke<void>('ozone_disconnect')).catch(() => {});
    };
  }, [desktop, deviceId]);

  function fail(error: unknown, label: string) {
    revoke(); setConnected(false);
    setNotice({ error: true, text: `${label}失败：${error instanceof Error ? error.message : String(error)}。可能已部分写入；草稿保留，不回滚、不重发。连接与授权已撤销，请重新连接读取实际内存。` });
    void enqueueOzone(() => invoke<void>('ozone_disconnect')).catch(() => {});
  }
  async function connect() {
    if (!desktop || transaction.current) return;
    const token = ++epoch.current; revoke(); setSnapshot(null); setNotice(null); transaction.current = true; setPending(true);
    try {
      const diagnostic = await enqueueOzone(() => { requireActive(token); return invoke<string>('ozone_connect'); });
      if (active(token)) { setConnected(true); setNotice({ error: false, text: `只读连接诊断：${diagnostic}。未写 RAM，未授权写入，也不保证目标正在运行。` }); }
    } catch (error) { if (active(token)) fail(error, '连接'); }
    finally { if (active(token)) { transaction.current = false; setPending(false); } }
  }
  async function disconnect() {
    const token = ++epoch.current; revoke(); setConnected(false); setSnapshot(null); setNotice(null); transaction.current = true; setPending(true);
    try {
      await enqueueOzone(() => invoke<void>('ozone_disconnect'));
      if (active(token)) setNotice({ error: false, text: 'Ozone 已断开，授权已撤销；未停止、复位或运行目标，也未改变运动目标。' });
    } catch (error) { if (active(token)) setNotice({ error: true, text: `断开失败：${String(error)}；写入授权已撤销。` }); }
    finally { if (active(token)) { transaction.current = false; setPending(false); } }
  }
  async function read() {
    if (!desktop || !connected || transaction.current) return;
    const token = epoch.current; transaction.current = true; setPending(true); setNotice(null);
    try {
      const actual = await enqueueOzone(() => { requireActive(token); return invoke<OzoneSnapshot>('ozone_read_parameters', { deviceId }); });
      requireActive(token); validateSnapshot(actual, definition); setSnapshot(actual);
      setNotice({ error: false, text: '已从当前 ELF 对应的实际控制器读取全部参数与镜像；独立草稿未改变。数值是读取时刻的 RAM，不是串口演示数据。' });
    } catch (error) { if (active(token)) fail(error, '读取'); }
    finally { if (active(token)) { transaction.current = false; setPending(false); } }
  }
  async function write(key: string) {
    const text = drafts[key] ?? '', value = text.trim() === '' ? NaN : Number(text);
    if (!desktop || !connected || !snapshot || transaction.current || !authorization.current || !finiteF32(value) || !fields.some(field => field.key === key)) return;
    const token = epoch.current, explicitAuthorization = authorization.current;
    revoke(); transaction.current = true; setPending(true); setNotice(null);
    try {
      const actual = await enqueueOzone(() => {
        requireActive(token);
        return invoke<OzoneParameter>('ozone_write_parameter', { deviceId, key, value: Math.fround(value), authorized: explicitAuthorization });
      });
      requireActive(token);
      setSnapshot(updateSnapshotParameter(snapshot, definition, key, value, actual));
      setNotice({ error: false, text: `${key} 已逐项写入实际字段及配置镜像，并由 Rust 按原始 float32 bits 回读确认。仅此字段已确认，其他字段未写；授权已用完。可再次读取完整快照。重启恢复固件 config，不写 Flash。` });
    } catch (error) { if (active(token)) fail(error, '单字段写入'); }
    finally { if (active(token)) { transaction.current = false; setPending(false); } }
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    const token = epoch.current;
    try {
      const parsed = parseTuningFile(await file.text(), definition);
      if (!active(token)) return;
      const next = Object.fromEntries(Object.entries(parsed.values).map(([key, value]) => [key, String(value)]));
      draftsByDevice.set(deviceId, next); setDrafts(next);
      setNotice({ error: false, text: '文件仅填入本设备草稿；未调用 IPC、未写 RAM、未发送串口命令。' });
    } catch (error) { if (active(token)) { revoke(); setNotice({ error: true, text: `导入拒绝，草稿未改：${error instanceof Error ? error.message : String(error)}` }); } }
  }
  function exportFile() {
    try {
      const text = exportTuningFile(definition, snapshot);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `dmdebug-ozone-tuning-${deviceId.toString(16)}.json`; anchor.click(); URL.revokeObjectURL(url);
      setNotice({ error: false, text: '已导出本设备实际内存回读，不含未提交草稿；文件不会自动恢复到设备。' });
    } catch (error) { revoke(); setNotice({ error: true, text: `导出失败：${error instanceof Error ? error.message : String(error)}` }); }
  }

  return <section className="panel ozone-panel" aria-label={`${definition.name} Ozone 参数`} aria-busy={pending}>
    <div className="panel-heading"><div><h2 className="panel-title">{definition.name} · {hexId(deviceId)}</h2><p>固定 TCP 127.0.0.1:19200 · {connected ? 'Ozone 已连接' : 'Ozone 未连接'} · {pending ? '等待当前请求完成' : '无在途请求'}</p></div></div>
    <div className="ozone-content">
      <p className="muted">仅使用当前 ELF 的固定设备 / 字段表达式，显示实际地址，不接受任意表达式或地址。连接只检查 Cortex-M7 类型及符号可读性。读取不提交固件请求；写入直接作用于活跃控制器及必要配置镜像。不会暂停、复位或运行目标，不覆盖目标位置，不自动重连。</p>
      <p className="notice warning">{definition.kind === 'm2006' ? 'M2006仅直接速度PID及输出轴rpm上限/静止阈值，无位置PD、轨迹或到位参数。' : 'DM角度、轨迹及完成阈值使用控制器内部输出轴deg单位。'}{definition.kind === 'linear' ? '伸缩也使用deg/deg/s，不是串口位置面板的mm；226.2mm/圈换算仍只在串口视图。' : ''}多个地址顺序读写期间目标仍可运行，快照并非原子采样。</p>
      {desktop ? <>
        <div className="actions">
          <button type="button" className="button" disabled={connected || pending} onClick={() => void connect()}>连接 Ozone</button>
          <button type="button" className="button" disabled={!connected && !pending} onClick={() => void disconnect()}>断开 Ozone</button>
          <button type="button" className="button" disabled={!connected || pending} onClick={() => void read()}>读取当前设备参数</button>
        </div>
        <label className="ozone-authorization" htmlFor={`${prefix}-authorize`}><input id={`${prefix}-authorize`} type="checkbox" checked={authorized} disabled={!connected || pending}
          onChange={event => { authorization.current = event.target.checked; setAuthorized(event.target.checked); }} />明确授权下一次单字段及其镜像 RAM 写入（每次写入后撤销）</label>
      </> : <p className="notice warning">Ozone TCP 仅限 Windows 桌面版。普通网页可查看参数目录、编辑草稿和导入 / 导出已读文件，但不能连接、读取目标 RAM 或写入；不提供假 TCP、假成功或 Web Serial 调参替代。</p>}
      {notice && <p className={`notice ${notice.error ? 'danger' : 'success'}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
      <div className="ozone-parameters">
        {fields.map(field => {
          const actual = snapshot?.parameters.find(parameter => parameter.key === field.key);
          const text = drafts[field.key] ?? '', value = text.trim() === '' ? NaN : Number(text);
          const valid = finiteF32(value);
          return <form className="ozone-parameter" key={field.key} onSubmit={event => { event.preventDefault(); void write(field.key); }}>
            <div className="ozone-parameter-title"><label htmlFor={`${prefix}-${field.key}`}>{field.label}<code>{field.key}</code></label><span className="mono">{field.unit}</span></div>
            <div className="ozone-value-row"><div><span className="eyebrow">实际内存回读</span><output className="mono">{actual ? String(actual.value) : '尚未读取'}</output></div>
              <div className="field"><label htmlFor={`${prefix}-${field.key}`}>独立草稿 · {field.unit}</label><input id={`${prefix}-${field.key}`} type="number" step="any" inputMode="decimal" value={text} disabled={pending}
                onChange={event => { const next = { ...drafts, [field.key]: event.target.value }; draftsByDevice.set(deviceId, next); setDrafts(next); }} /></div>
              <button type="submit" className="button primary" disabled={!desktop || !connected || pending || !authorized || !valid || !snapshot}>写入此字段到 RAM</button>
            </div>
            {text !== '' && !valid && <p className="text-danger">草稿必须为有限 float32；不做物理参数范围检查。</p>}
            {field.note && <p className="muted">{field.note}</p>}
            <div className="ozone-locations">{actual ? <><div><span>实际字段</span><code>{actual.expression}</code><span className="mono">0x{actual.address.toString(16).toUpperCase().padStart(8, '0')}</span></div>
              {actual.mirrors.length ? actual.mirrors.map(mirror => <div key={mirror.expression}><span>同步镜像</span><code>{mirror.expression}</code><span className="mono">0x{mirror.address.toString(16).toUpperCase().padStart(8, '0')} · {String(mirror.value)}</span></div>) : <p className="muted">此字段无配置镜像。</p>}</> : <p className="muted">连接并读取后显示当前 ELF 解析的表达式、实际地址及镜像；不猜偏移。</p>}</div>
          </form>;
        })}
      </div>
      <div className="actions tuning-files">
        <label className="field" htmlFor={`${prefix}-file`}>导入本设备 JSON · 仅草稿<input id={`${prefix}-file`} type="file" accept=".json,application/json" disabled={pending} onChange={event => void importFile(event)} /></label>
        <button type="button" className="button" disabled={pending || !snapshot} onClick={exportFile}>导出实际回读 JSON</button>
        <button type="button" className="button subtle" disabled={pending || !snapshot} onClick={() => {
          if (!snapshot) return;
          const next = Object.fromEntries(snapshot.parameters.map(parameter => [parameter.key, String(parameter.value)])); draftsByDevice.set(deviceId, next); setDrafts(next);
          setNotice({ error: false, text: '已明确丢弃草稿并复制实际回读；未写 RAM。' });
        }}>丢弃草稿，复制实际回读</button>
      </div>
    </div>
  </section>;
}
