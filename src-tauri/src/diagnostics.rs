//! 独立只读输入诊断，不使用电机控制运行时。
use crate::input::InputDevice;
#[cfg(test)]
use crate::input::{InputAxis, InputButton, InputHat};
#[cfg(windows)]
use crate::input::winmm;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

const RECENT_EVENTS: usize = 200;
const POLL_INTERVAL: Duration = Duration::from_millis(20);


#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvent {
    pub sequence: u64,
    pub time_ms: u64,
    pub device_key: String,
    pub index: Option<usize>,
    pub kind: String,
    pub code: Option<u32>,
    pub name: String,
    pub value: Option<f32>,
    pub raw_value: Option<u32>,
    pub stage: String,
    pub detail: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSnapshot {
    pub supported: bool,
    pub running: bool,
    pub paused: bool,
    pub error: String,
    pub log_path: String,
    pub stage: String,
    pub sequence: u64,
    pub devices: Vec<InputDevice>,
    pub events: VecDeque<DiagnosticEvent>,
}

#[derive(Serialize)]
struct LogLine<'a> {
    #[serde(flatten)]
    event: &'a DiagnosticEvent,
    #[serde(skip_serializing_if = "Option::is_none")]
    device: Option<&'a InputDevice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<serde_json::Value>,
}

struct Recorder {
    snapshot: DiagnosticSnapshot,
    writer: Option<Box<dyn Write + Send>>,
    active: HashMap<usize, usize>,
    generations: HashMap<usize, u64>,
}

impl Recorder {
    fn pending() -> Self {
        Self {
            snapshot: DiagnosticSnapshot {
                supported: true,
                running: false,
                paused: false,
                error: String::new(),
                log_path: String::new(),
                stage: "普通模式：逐个拨杆和按键".into(),
                sequence: 0,
                devices: Vec::new(),
                events: VecDeque::with_capacity(RECENT_EVENTS),
            },
            writer: None,
            active: HashMap::new(),
            generations: HashMap::new(),
        }
    }

    fn event(&self, kind: &str, index: Option<usize>, time: SystemTime) -> DiagnosticEvent {
        DiagnosticEvent {
            sequence: 0,
            time_ms: milliseconds(time),
            device_key: index.and_then(|id| self.active.get(&id))
                .map(|&position| self.snapshot.devices[position].key.clone()).unwrap_or_default(),
            index,
            kind: kind.into(),
            code: None,
            name: String::new(),
            value: None,
            raw_value: None,
            stage: self.snapshot.stage.clone(),
            detail: String::new(),
        }
    }

    fn remember(&mut self, mut event: DiagnosticEvent) -> DiagnosticEvent {
        self.snapshot.sequence += 1;
        event.sequence = self.snapshot.sequence;
        if self.snapshot.events.len() == RECENT_EVENTS {
            self.snapshot.events.pop_front();
        }
        self.snapshot.events.push_back(event.clone());
        event
    }

    fn emit(&mut self, event: DiagnosticEvent, device: Option<InputDevice>, force: bool,
            session: Option<serde_json::Value>) {
        if self.snapshot.paused && !force {
            return;
        }
        let event = self.remember(event);
        let result = self.writer.as_mut().map(|writer| {
            serde_json::to_writer(&mut **writer, &LogLine { event: &event, device: device.as_ref(), session })
                .map_err(io::Error::other)?;
            writer.write_all(b"\n")?;
            writer.flush()
        });
        if let Some(Err(error)) = result {
            self.writer = None;
            self.snapshot.running = false;
            self.add_error(format!("日志写入失败，已停止保存（{}）：{error}", self.snapshot.log_path));
            let mut failure = self.event("Error", None, SystemTime::now());
            failure.detail = self.snapshot.error.clone();
            // 日志写入器失效后无法保存自身错误，在内存快照保留明确提示。
            self.remember(failure);
        }
    }

    fn add_error(&mut self, message: String) {
        if !self.snapshot.error.is_empty() {
            self.snapshot.error.push('\n');
        }
        self.snapshot.error.push_str(&message);
    }

    fn error(&mut self, message: String) {
        self.add_error(message.clone());
        let mut event = self.event("Error", None, SystemTime::now());
        event.detail = message;
        self.emit(event, None, true, None);
    }

    fn initialize(&mut self, directory: Result<PathBuf, String>) {
        let opened = directory.and_then(|directory| {
            if !directory.is_absolute() {
                return Err("应用日志目录不是绝对路径，拒绝写入工作目录".into());
            }
            let directory = directory.join("gamepad-diagnostics");
            fs::create_dir_all(&directory).map_err(|error| format!("创建诊断日志目录失败（{}）：{error}", directory.display()))?;
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
            let path = directory.join(format!("session-{stamp}-{}.jsonl", std::process::id()));
            self.snapshot.log_path = path.to_string_lossy().into_owned();
            OpenOptions::new().write(true).create_new(true).open(&path)
                .map_err(|error| format!("创建诊断日志失败（{}）：{error}", path.display()))
        });
        match opened {
            Ok(file) => self.writer = Some(Box::new(file)),
            Err(error) => self.add_error(error),
        }
        let mut event = self.event("Session", None, SystemTime::now());
        event.detail = "Windows 输入记录器本身不打开串口、不连接 Ozone、不发送电机或振动命令；工作台控制功能由其他模块管理。名称和 mapping 不能证明 Analog/Select 模式；用人工阶段对比。".into();
        self.emit(event, None, true, Some(serde_json::json!({
            "application": "DMDebug input diagnostics", "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
            "driver": "Windows WinMM", "api": input_api(),
            "forceFeedback": false, "pollIntervalMs": POLL_INTERVAL.as_millis(),
            "values": "Windows calibrated X/Y/Z/R/U/V integers and declared ranges; not USB HID packets; no gilrs mapping",
            "timeMs": "UNIX epoch milliseconds at snapshot observation",
            "focus": "Focus is recorded only; it does not gate WinMM sampling",
            "logPath": self.snapshot.log_path
        })));
        if !self.snapshot.error.is_empty() {
            let mut event = self.event("Error", None, SystemTime::now());
            event.detail = self.snapshot.error.clone();
            self.emit(event, None, true, None);
        }
    }

    fn connect(&mut self, mut device: InputDevice, time: SystemTime, detail: String) {
        if let Some(&position) = self.active.get(&device.index) {
            if self.snapshot.devices[position].connected {
                self.disconnect(device.index, time, "设备身份或 mapping 改变，保留旧连接快照".into());
            }
        }
        let generation = self.generations.entry(device.index).or_default();
        *generation += 1;
        // 即使 VID/PID/UUID 不变，也使用连接代次区分重新插入的设备。
        device.key = format!("{}:{}:{}:{}:{}:{}:{}", device.index, generation, device.uuid,
            device.vendor_id.map(|id| format!("{id:04x}")).unwrap_or_default(),
            device.product_id.map(|id| format!("{id:04x}")).unwrap_or_default(), device.name, device.mapping);
        device.connected = true;
        self.active.insert(device.index, self.snapshot.devices.len());
        self.snapshot.devices.push(device.clone());
        let mut event = self.event("Connected", Some(device.index), time);
        event.name = device.name.clone();
        event.detail = detail;
        self.emit(event, Some(device), false, None);
    }

    fn disconnect(&mut self, index: usize, time: SystemTime, detail: String) {
        let device = self.active.get(&index).map(|&position| {
            self.snapshot.devices[position].connected = false;
            self.snapshot.devices[position].clone()
        });
        let mut event = self.event("Disconnected", Some(index), time);
        event.detail = detail;
        self.emit(event, device, false, None);
    }

    fn observe(&mut self, frame: &InputDevice, time: SystemTime) {
        let position = self.active.get(&frame.index).copied();
        let same_layout = position.is_some_and(|position| {
            let old = &self.snapshot.devices[position];
            old.connected && old.generation == frame.generation && old.name == frame.name && old.uuid == frame.uuid
                && old.vendor_id == frame.vendor_id && old.product_id == frame.product_id
                && old.mapping == frame.mapping && old.axes.len() == frame.axes.len()
                && old.buttons.len() == frame.buttons.len() && old.hats.len() == frame.hats.len()
                && old.axes.iter().zip(&frame.axes).all(|(a, b)|
                    a.code == b.code && a.name == b.name && a.minimum == b.minimum && a.maximum == b.maximum)
                && old.buttons.iter().zip(&frame.buttons).all(|(a, b)| a.code == b.code && a.name == b.name)
                && old.hats.iter().zip(&frame.hats).all(|(a, b)| a.code == b.code && a.name == b.name)
        });
        if !same_layout {
            self.connect(frame.clone(), time, "Windows 设备连接或能力/量程变化；保存完整当前基线".into());
            return;
        }
        let position = position.expect("已匹配的设备必有活动位置");
        for (axis_index, axis) in frame.axes.iter().enumerate() {
            let old = &mut self.snapshot.devices[position].axes[axis_index];
            if old.raw_value == axis.raw_value { continue; }
            old.raw_value = axis.raw_value;
            old.value = axis.value;
            let mut event = self.event("AxisChanged", Some(frame.index), time);
            event.code = Some(axis.code);
            event.name.clone_from(&axis.name);
            event.raw_value = Some(axis.raw_value);
            event.value = Some(axis.value);
            event.detail = format!("Windows 校准轴；声明范围 {}..{}；未反向、未自动端点校准", axis.minimum, axis.maximum);
            self.emit(event, None, false, None);
        }
        for (button_index, button) in frame.buttons.iter().enumerate() {
            let old = &mut self.snapshot.devices[position].buttons[button_index];
            if old.pressed == button.pressed { continue; }
            old.pressed = button.pressed;
            old.value = button.value;
            let mut event = self.event(if button.pressed { "ButtonPressed" } else { "ButtonReleased" }, Some(frame.index), time);
            event.code = Some(button.code);
            event.name.clone_from(&button.name);
            event.raw_value = Some(u32::from(button.pressed));
            event.value = Some(button.value);
            event.detail = "Windows 物理按钮位图；不由模拟轴合成按钮".into();
            self.emit(event, None, false, None);
        }
        for (hat_index, hat) in frame.hats.iter().enumerate() {
            let old = &mut self.snapshot.devices[position].hats[hat_index];
            if old.value == hat.value { continue; }
            old.value = hat.value;
            let mut event = self.event("PovChanged", Some(frame.index), time);
            event.code = Some(hat.code);
            event.name.clone_from(&hat.name);
            event.raw_value = hat.value;
            event.value = hat.value.map(|value| value as f32);
            event.detail = "POV 百分之一度；null 表示居中；不合并到摇杆轴".into();
            self.emit(event, None, false, None);
        }
    }

    fn mark(&mut self, label: String) -> Result<(), String> {
        let label = label.trim();
        if label.is_empty() {
            return Err("请填写阶段或备注".into());
        }
        self.snapshot.stage = label.into();
        let mut event = self.event("Stage", None, SystemTime::now());
        event.detail = label.into();
        // 暂停原始输入记录时，操作员的阶段标记仍可明确保存。
        self.emit(event, None, true, None);
        self.saved_result()
    }

    fn pause(&mut self, paused: bool) -> Result<(), String> {
        if self.snapshot.paused != paused {
            self.snapshot.paused = paused;
            let mut event = self.event(if paused { "Paused" } else { "Resumed" }, None, SystemTime::now());
            event.detail = if paused { "暂停输入事件记录；设备最新值仍更新，阶段标记仍保存" }
                else { "继续输入事件记录；暂停期间的输入不会补写" }.into();
            self.emit(event, None, true, None);
            if !paused {
                // 保存恢复时刻的真实基线，不补造或回放暂停期间的输入。
                for position in 0..self.snapshot.devices.len() {
                    if self.snapshot.devices[position].connected {
                        let device = self.snapshot.devices[position].clone();
                        let mut event = self.event("DeviceSnapshot", Some(device.index), SystemTime::now());
                        event.detail = "恢复记录时的当前设备快照".into();
                        self.emit(event, Some(device), true, None);
                    }
                }
            }
        }
        self.saved_result()
    }

    fn saved_result(&self) -> Result<(), String> {
        if self.writer.is_some() { Ok(()) } else {
            Err(if self.snapshot.error.is_empty() { "日志不可用；此次操作仅更新页面状态，未保存".into() }
                else { self.snapshot.error.clone() })
        }
    }
}


#[derive(Clone)]
pub struct DiagnosticState {
    recorder: Arc<Mutex<Recorder>>,
    stop: Arc<AtomicBool>,
}

impl Default for DiagnosticState {
    fn default() -> Self {
        Self { recorder: Arc::new(Mutex::new(Recorder::pending())), stop: Arc::new(AtomicBool::new(false)) }
    }
}

impl DiagnosticState {
    fn lock(&self) -> MutexGuard<'_, Recorder> {
        self.recorder.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn record_focus(&self, focused: bool) {
        let mut recorder = self.lock();
        let mut event = recorder.event("Focus", None, SystemTime::now());
        event.name = "windowFocused".into();
        event.value = Some(if focused { 1.0 } else { 0.0 });
        event.detail = if focused { "诊断窗口获得焦点；焦点仅作日志标记" }
            else { "诊断窗口失去焦点；WinMM 采集继续，不据此推断手柄模式" }.into();
        recorder.emit(event, None, true, None);
    }

    pub(crate) fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    pub(crate) fn start(&self, directory: Result<PathBuf, String>) {
        self.lock().initialize(directory);
        let state = self.clone();
        if let Err(error) = thread::Builder::new().name("usb-input-diagnostics".into()).spawn(move || {
            if let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| state.read_inputs())) {
                let detail = panic.downcast_ref::<&str>().copied()
                    .or_else(|| panic.downcast_ref::<String>().map(String::as_str)).unwrap_or("未知 panic");
                let mut recorder = state.lock();
                recorder.snapshot.running = false;
                recorder.error(format!("只读输入线程异常停止：{detail}"));
            }
        }) {
            self.lock().error(format!("无法启动只读输入线程：{error}"));
        }
    }

    #[cfg(windows)]
    fn read_inputs(&self) {
        let mut reader = match winmm::Reader::new() {
            Ok(reader) => reader,
            Err(error) => {
                self.lock().error(format!("Windows 轴采集初始化失败：{error}"));
                return;
            }
        };
        {
            let mut recorder = self.lock();
            recorder.snapshot.running = recorder.writer.is_some();
            let mut event = recorder.event("DriverReady", None, SystemTime::now());
            event.detail = format!("{}；独立 Windows 轴/物理按钮/POV；不使用 gilrs 映射", input_api());
            recorder.emit(event, None, true, None);
        }
        let mut previous_slot_count = 0;
        while !self.stop.load(Ordering::Relaxed) {
            let count = reader.slot_count();
            for index in count..previous_slot_count {
                let mut recorder = self.lock();
                if recorder.active.get(&index).is_some_and(|&position| recorder.snapshot.devices[position].connected) {
                    recorder.disconnect(index, SystemTime::now(), "Windows 驱动撤销设备槽位".into());
                }
            }
            previous_slot_count = count;
            for index in 0..count {
                let time = SystemTime::now();
                match reader.read(index) {
                    Ok(Some(frame)) => self.lock().observe(frame, time),
                    Ok(None) => {
                        let mut recorder = self.lock();
                        if recorder.active.get(&index).is_some_and(|&position| recorder.snapshot.devices[position].connected) {
                            recorder.disconnect(index, time, "Windows 报告设备已断开".into());
                        }
                    }
                    Err(error) => {
                        let mut recorder = self.lock();
                        recorder.snapshot.running = false;
                        recorder.error(format!("Windows 设备 #{index} 采集失败：{error}"));
                        return;
                    }
                }
            }
            thread::sleep(POLL_INTERVAL);
        }
        let mut recorder = self.lock();
        recorder.snapshot.running = false;
        let event = recorder.event("SessionStopped", None, SystemTime::now());
        recorder.emit(event, None, true, None);
    }

    #[cfg(not(windows))]
    fn read_inputs(&self) {
        let mut recorder = self.lock();
        recorder.snapshot.supported = false;
        recorder.error("此独立轴诊断使用 Windows WinMM；当前平台不支持，不回退到标准手柄映射".into());
    }
}

fn milliseconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
}

fn input_api() -> &'static str {
    "Windows WinMM / joyGetPosEx / independent calibrated axes"
}

#[tauri::command]
pub fn diagnostic_snapshot(state: State<'_, DiagnosticState>) -> DiagnosticSnapshot {
    state.lock().snapshot.clone()
}

#[tauri::command]
pub fn diagnostic_mark(label: String, state: State<'_, DiagnosticState>) -> Result<(), String> {
    state.lock().mark(label)
}

#[tauri::command]
pub fn diagnostic_pause(paused: bool, state: State<'_, DiagnosticState>) -> Result<(), String> {
    state.lock().pause(paused)
}

#[tauri::command]
fn application_mode() -> &'static str { "input-diagnostics" }

/// 独立 Builder 只注册诊断命令，不注册串口、Ozone 或电机命令。
pub fn run() {
    let mut context = tauri::generate_context!();
    for window in &mut context.config_mut().app.windows {
        // 启动时不抢占其他应用焦点；由用户自行切到诊断窗口。
        window.focus = false;
        // 独立缓存避免与正在运行的工作台共享 WebView2 配置和调试参数。
        window.data_directory = Some(PathBuf::from("com.stm32.dmdebugstation.input-diagnostics"));
    }
    tauri::Builder::default()
        .manage(DiagnosticState::default())
        .setup(|app| {
            let state = app.state::<DiagnosticState>();
            state.start(app.path().app_log_dir().map_err(|error| format!("无法获取应用日志目录：{error}")));
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.set_title("USB手柄输入诊断 · 只读 / 不控制电机") {
                    state.lock().error(format!("设置只读诊断窗口标题失败：{error}"));
                }
                match window.is_focused() {
                    Ok(focused) => state.record_focus(focused),
                    Err(error) => state.lock().error(format!("读取诊断窗口焦点失败：{error}")),
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let state = window.state::<DiagnosticState>();
            match event {
                tauri::WindowEvent::Focused(focused) => state.record_focus(*focused),
                tauri::WindowEvent::Destroyed => {
                    state.record_focus(false);
                    state.stop.store(true, Ordering::Relaxed);
                }
                _ => {},
            }
        })
        .invoke_handler(tauri::generate_handler![application_mode, diagnostic_snapshot,
            diagnostic_mark, diagnostic_pause])
        .run(context)
        .expect("error while running read-only USB input diagnostics");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempDirectory(PathBuf);
    impl TempDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("dm-input-diag-{}-{}-{}", std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDirectory {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn recorder(directory: &TempDirectory) -> Recorder {
        let mut recorder = Recorder::pending();
        recorder.initialize(Ok(directory.0.clone()));
        assert!(recorder.snapshot.error.is_empty());
        recorder
    }

    fn device(index: usize, mapping: &str) -> InputDevice {
        InputDevice { key: String::new(), index, generation: 1, name: "Windows test fixture".into(),
            uuid: String::new(), vendor_id: None, product_id: None, mapping: mapping.into(), connected: true,
            axes: ["X", "Y", "Z", "Z旋转"].into_iter().enumerate().map(|(code, name)| InputAxis {
                code: code as u32, name: name.into(), value: 0.0, raw_value: 500, minimum: 0, maximum: 1000,
            }).collect(),
            buttons: (0..2).map(|code| InputButton { code, name: format!("按钮 {}", code + 1), value: 0.0, pressed: false }).collect(),
            hats: vec![InputHat { code: 0, name: "POV".into(), value: None }] }
    }

    fn move_axis(frame: &mut InputDevice, axis: usize, raw: u32) {
        frame.axes[axis].raw_value = raw;
        frame.axes[axis].value = raw as f32 / 500.0 - 1.0;
    }

    fn lines(recorder: &Recorder) -> Vec<serde_json::Value> {
        fs::read_to_string(&recorder.snapshot.log_path).unwrap().lines()
            .map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    #[test]
    fn axis_changes_never_mutate_other_axes_or_synthesize_buttons() {
        let directory = TempDirectory::new();
        let mut recorder = recorder(&directory);
        let mut frame = device(0, "Windows axes");
        recorder.observe(&frame, UNIX_EPOCH);
        move_axis(&mut frame, 0, 1000);
        recorder.observe(&frame, UNIX_EPOCH);
        let pad = &recorder.snapshot.devices[0];
        assert_eq!(pad.axes[0].raw_value, 1000);
        assert_eq!(pad.axes[2].raw_value, 500);
        assert_eq!(pad.axes[3].raw_value, 500);
        assert!(pad.buttons.iter().all(|button| !button.pressed));
        move_axis(&mut frame, 3, 0);
        frame.hats[0].value = Some(9000);
        recorder.observe(&frame, UNIX_EPOCH);
        assert_eq!(recorder.snapshot.devices[0].axes[2].raw_value, 500);
        assert_eq!(recorder.snapshot.devices[0].axes[3].value, -1.0);
        let saved = lines(&recorder);
        let axes: Vec<_> = saved.iter().filter(|event| event["kind"] == "AxisChanged").collect();
        assert_eq!(axes.len(), 2);
        assert_eq!(axes[1]["name"], "Z旋转");
        assert_eq!(axes[1]["rawValue"], 0);
        assert!(!saved.iter().any(|event| event["kind"] == "ButtonPressed"));
        assert_eq!(saved.last().unwrap()["kind"], "PovChanged");
        assert_eq!(saved.last().unwrap()["rawValue"], 9000);
    }

    #[test]
    fn reconnect_and_range_changes_keep_old_identity_and_history() {
        let directory = TempDirectory::new();
        let mut recorder = recorder(&directory);
        let mut frame = device(0, "Windows axes");
        recorder.observe(&frame, UNIX_EPOCH);
        let first_key = recorder.snapshot.devices[0].key.clone();
        move_axis(&mut frame, 2, 800);
        recorder.observe(&frame, UNIX_EPOCH);
        recorder.disconnect(0, UNIX_EPOCH, "unplugged".into());
        recorder.observe(&frame, UNIX_EPOCH);
        frame.axes[2].maximum = 1200;
        recorder.observe(&frame, UNIX_EPOCH);
        assert_eq!(recorder.snapshot.devices.len(), 3);
        assert_ne!(recorder.snapshot.devices[1].key, first_key);
        assert_ne!(recorder.snapshot.devices[2].key, recorder.snapshot.devices[1].key);
        assert!(!recorder.snapshot.devices[0].connected);
        assert!(!recorder.snapshot.devices[1].connected);
        assert!(recorder.snapshot.devices[2].connected);
        assert!(recorder.snapshot.events.iter().any(|event| event.device_key == first_key && event.raw_value == Some(800)));
        assert_eq!(recorder.snapshot.devices[0].axes[2].maximum, 1000);
        assert_eq!(recorder.snapshot.devices[2].axes[2].maximum, 1200);
    }

    #[test]
    fn stages_and_pause_keep_live_values_without_recording_paused_input() {
        let directory = TempDirectory::new();
        let mut recorder = recorder(&directory);
        let mut frame = device(0, "Windows axes");
        recorder.observe(&frame, UNIX_EPOCH);
        recorder.mark("准备按 Analog".into()).unwrap();
        recorder.pause(true).unwrap();
        let count = lines(&recorder).len();
        let sequence = recorder.snapshot.sequence;
        move_axis(&mut frame, 2, 100);
        frame.buttons[0].pressed = true;
        frame.buttons[0].value = 1.0;
        frame.hats[0].value = Some(18000);
        recorder.observe(&frame, UNIX_EPOCH);
        assert_eq!(recorder.snapshot.sequence, sequence);
        assert_eq!(lines(&recorder).len(), count);
        assert_eq!(recorder.snapshot.devices[0].axes[2].raw_value, 100);
        assert_eq!(recorder.snapshot.devices[0].hats[0].value, Some(18000));
        assert!(recorder.snapshot.devices[0].buttons[0].pressed);
        recorder.mark("Analog LED 由用户观察；未推断模式".into()).unwrap();
        assert_eq!(lines(&recorder).last().unwrap()["kind"], "Stage");
        recorder.pause(false).unwrap();
        let saved = lines(&recorder);
        let baseline = saved.iter().find(|event| event["kind"] == "DeviceSnapshot").unwrap();
        assert_eq!(baseline["device"]["axes"][2]["rawValue"], 100);
        assert_eq!(baseline["device"]["buttons"][0]["pressed"], true);
        assert!(!saved.iter().any(|event| event["kind"] == "AxisChanged"));
        move_axis(&mut frame, 2, 600);
        recorder.observe(&frame, UNIX_EPOCH);
        assert_eq!(lines(&recorder).last().unwrap()["stage"], "Analog LED 由用户观察；未推断模式");
    }

    #[test]
    fn jsonl_keeps_all_events_while_snapshot_only_keeps_two_hundred() {
        let directory = TempDirectory::new();
        let mut recorder = recorder(&directory);
        let mut frame = device(0, "Windows axes");
        recorder.observe(&frame, UNIX_EPOCH);
        for number in 1..=350 {
            move_axis(&mut frame, 0, 500 + number);
            recorder.observe(&frame, UNIX_EPOCH + Duration::from_millis(number as u64));
        }
        let saved = lines(&recorder);
        assert_eq!(saved.len(), 352);
        assert_eq!(recorder.snapshot.events.len(), 200);
        for (index, line) in saved.iter().enumerate() {
            assert_eq!(line["sequence"].as_u64().unwrap(), index as u64 + 1);
        }
        assert!(PathBuf::from(&recorder.snapshot.log_path).is_absolute());
        assert_eq!(saved.last().unwrap()["timeMs"], 350);
        assert_eq!(saved.last().unwrap()["rawValue"], 850);
    }

    struct FailingWriter;
    impl Write for FailingWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::StorageFull, "fixture disk full"))
        }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }

    #[test]
    fn write_failure_stops_claiming_to_save_but_retains_live_diagnostics() {
        let directory = TempDirectory::new();
        let mut recorder = recorder(&directory);
        let mut frame = device(0, "Windows axes");
        recorder.observe(&frame, UNIX_EPOCH);
        recorder.writer = Some(Box::new(FailingWriter));
        recorder.snapshot.running = true;
        move_axis(&mut frame, 2, 250);
        recorder.observe(&frame, UNIX_EPOCH);
        assert!(recorder.writer.is_none());
        assert!(!recorder.snapshot.running);
        assert!(recorder.snapshot.error.contains("日志写入失败"));
        assert!(recorder.snapshot.events.iter().any(|event| event.kind == "Error"));
        move_axis(&mut frame, 2, 750);
        recorder.observe(&frame, UNIX_EPOCH);
        assert_eq!(recorder.snapshot.devices[0].axes[2].raw_value, 750);
        assert!(recorder.mark("Select 单独对比".into()).is_err());
    }

    #[test]
    fn invalid_log_directory_does_not_prevent_error_snapshot_or_annotations() {
        let directory = TempDirectory::new();
        let blocked = directory.0.join("not-a-directory");
        fs::File::create(&blocked).unwrap();
        let mut recorder = Recorder::pending();
        recorder.initialize(Ok(blocked));
        assert!(recorder.writer.is_none());
        assert!(!recorder.snapshot.running);
        assert!(!recorder.snapshot.error.is_empty());
        assert!(recorder.snapshot.events.iter().any(|event| event.kind == "Session"));
        assert!(recorder.mark("仍可查看错误".into()).is_err());
        assert_eq!(recorder.snapshot.stage, "仍可查看错误");
    }

    #[test]
    fn driver_failure_and_focus_are_saved_without_hardware() {
        let directory = TempDirectory::new();
        let state = DiagnosticState::default();
        state.lock().initialize(Ok(directory.0.clone()));
        state.lock().error("手柄输入驱动初始化失败：fixture unavailable".into());
        state.record_focus(false);
        let recorder = state.lock();
        assert!(!recorder.snapshot.running);
        assert!(recorder.snapshot.error.contains("fixture unavailable"));
        let saved = lines(&recorder);
        assert!(saved.iter().any(|line| line["kind"] == "Error"));
        assert_eq!(saved.last().unwrap()["kind"], "Focus");
        assert_eq!(saved.last().unwrap()["value"], 0.0);
    }
}
