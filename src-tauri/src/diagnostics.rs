//! 独立只读输入诊断，不使用电机控制运行时。
use gilrs::{EventType, Gamepad, GilrsBuilder, MappingSource};
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
pub struct DiagnosticAxis {
    pub code: u32,
    pub name: String,
    pub value: f32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticButton {
    pub code: u32,
    pub name: String,
    pub value: f32,
    pub pressed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticDevice {
    pub key: String,
    pub index: usize,
    pub name: String,
    pub uuid: String,
    pub vendor_id: Option<u16>,
    pub product_id: Option<u16>,
    pub mapping: String,
    pub connected: bool,
    pub axes: Vec<DiagnosticAxis>,
    pub buttons: Vec<DiagnosticButton>,
}

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
    pub devices: Vec<DiagnosticDevice>,
    pub events: VecDeque<DiagnosticEvent>,
}

#[derive(Serialize)]
struct LogLine<'a> {
    #[serde(flatten)]
    event: &'a DiagnosticEvent,
    #[serde(skip_serializing_if = "Option::is_none")]
    device: Option<&'a DiagnosticDevice>,
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

    fn emit(&mut self, event: DiagnosticEvent, device: Option<DiagnosticDevice>, force: bool,
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
        event.detail = "只读 USB 输入诊断；不打开串口、不连接 Ozone、不启动控制线程、不发送电机或振动命令。名称和 mapping 不能证明 Analog/Select 模式；用人工阶段对比。".into();
        self.emit(event, None, true, Some(serde_json::json!({
            "application": "GamepadInputCheck", "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
            "driver": "gilrs 0.11.2", "api": input_api(),
            "defaultFilters": false, "forceFeedback": false, "pollIntervalMs": 20,
            "values": "gilrs normalized values with original platform Code; not USB HID packets",
            "timeMs": "UNIX epoch milliseconds; input events retain gilrs event timestamps",
            "focus": "Windows WGI input requires this native window to be focused; focus is never forced",
            "logPath": self.snapshot.log_path
        })));
        if !self.snapshot.error.is_empty() {
            let mut event = self.event("Error", None, SystemTime::now());
            event.detail = self.snapshot.error.clone();
            self.emit(event, None, true, None);
        }
    }

    fn connect(&mut self, mut device: DiagnosticDevice, time: SystemTime, detail: String) {
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

    fn input(&mut self, index: usize, raw: RawInput, time: SystemTime) {
        if let Some(&position) = self.active.get(&index) {
            let device = &mut self.snapshot.devices[position];
            if let (Some(code), Some(value)) = (raw.code, raw.value) {
                if raw.kind == "AxisChanged" {
                    match device.axes.iter_mut().find(|axis| axis.code == code) {
                        Some(axis) => { axis.value = value; axis.name.clone_from(&raw.name); }
                        None => {
                            device.axes.push(DiagnosticAxis { code, name: raw.name.clone(), value });
                            device.axes.sort_unstable_by_key(|axis| axis.code);
                        }
                    }
                } else if let Some(pressed) = raw.pressed {
                    match device.buttons.iter_mut().find(|button| button.code == code) {
                        Some(button) => {
                            button.value = value;
                            button.pressed = pressed;
                            button.name.clone_from(&raw.name);
                        }
                        None => {
                            device.buttons.push(DiagnosticButton { code, name: raw.name.clone(), value, pressed });
                            device.buttons.sort_unstable_by_key(|button| button.code);
                        }
                    }
                }
            }
        }
        let mut event = self.event(raw.kind, Some(index), time);
        event.code = raw.code;
        event.name = raw.name;
        event.value = raw.value;
        event.detail = raw.detail;
        self.emit(event, None, false, None);
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

struct RawInput {
    kind: &'static str,
    code: Option<u32>,
    name: String,
    value: Option<f32>,
    pressed: Option<bool>,
    detail: String,
}

impl RawInput {
    fn from_event(event: EventType, gamepad: &Gamepad<'_>) -> Self {
        let mut raw = Self { kind: "Other", code: None, name: String::new(), value: None,
            pressed: None, detail: format!("{event:?}") };
        match event {
            EventType::AxisChanged(axis, value, code) => {
                raw.kind = "AxisChanged";
                raw.code = Some(code.into_u32());
                raw.name = format!("{axis:?}");
                raw.value = Some(value);
            }
            EventType::ButtonPressed(button, code) | EventType::ButtonReleased(button, code)
            | EventType::ButtonRepeated(button, code) | EventType::ButtonChanged(button, _, code) => {
                raw.name = format!("{button:?}");
                raw.code = Some(code.into_u32());
                let cached = gamepad.state().button_data(code);
                let (kind, value, pressed) = match event {
                    EventType::ButtonPressed(_, _) => ("ButtonPressed", 1.0, true),
                    EventType::ButtonReleased(_, _) => ("ButtonReleased", 0.0, false),
                    EventType::ButtonRepeated(_, _) => ("ButtonRepeated", cached.map_or(1.0, |data| data.value()), true),
                    EventType::ButtonChanged(_, value, _) => ("ButtonChanged", value,
                        cached.map_or(value >= 0.75, |data| data.is_pressed())),
                    _ => unreachable!(),
                };
                raw.kind = kind;
                raw.value = Some(value);
                raw.pressed = Some(pressed);
            }
            EventType::Dropped => raw.kind = "Dropped",
            EventType::ForceFeedbackEffectCompleted => raw.kind = "ForceFeedbackEffectCompleted",
            EventType::Connected => raw.kind = "Connected",
            EventType::Disconnected => raw.kind = "Disconnected",
            _ => {},
        }
        raw
    }
}

struct DeviceIdentity {
    uuid: [u8; 16],
    name: String,
    vendor_id: Option<u16>,
    product_id: Option<u16>,
    source: MappingSource,
    map_name: String,
}

impl DeviceIdentity {
    fn matches(&self, gamepad: &Gamepad<'_>) -> bool {
        self.uuid == gamepad.uuid() && self.name == gamepad.os_name()
            && self.vendor_id == gamepad.vendor_id() && self.product_id == gamepad.product_id()
            && self.source == gamepad.mapping_source() && self.map_name == gamepad.map_name().unwrap_or_default()
    }

    fn read(gamepad: &Gamepad<'_>) -> Self {
        Self { uuid: gamepad.uuid(), name: gamepad.os_name().into(), vendor_id: gamepad.vendor_id(),
            product_id: gamepad.product_id(), source: gamepad.mapping_source(),
            map_name: gamepad.map_name().unwrap_or_default().into() }
    }

    fn device(&self, index: usize, gamepad: &Gamepad<'_>) -> DiagnosticDevice {
        let mut axes: Vec<_> = gamepad.state().axes().map(|(code, data)| DiagnosticAxis {
            code: code.into_u32(), name: gamepad.axis_or_btn_name(code).map(|name| format!("{name:?}"))
                .unwrap_or_else(|| "Unknown".into()), value: data.value(),
        }).collect();
        let mut buttons: Vec<_> = gamepad.state().buttons().map(|(code, data)| DiagnosticButton {
            code: code.into_u32(), name: gamepad.axis_or_btn_name(code).map(|name| format!("{name:?}"))
                .unwrap_or_else(|| "Unknown".into()), value: data.value(), pressed: data.is_pressed(),
        }).collect();
        axes.sort_unstable_by_key(|axis| axis.code);
        buttons.sort_unstable_by_key(|button| button.code);
        let mut uuid = String::with_capacity(32);
        for byte in self.uuid {
            use std::fmt::Write as _;
            let _ = write!(&mut uuid, "{byte:02x}");
        }
        DiagnosticDevice { key: String::new(), index, name: self.name.clone(), uuid,
            vendor_id: self.vendor_id, product_id: self.product_id,
            mapping: format!("gilrs/{:?} {}", self.source, self.map_name), connected: true, axes, buttons }
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
        event.detail = if focused { "诊断窗口获得焦点；WGI 可在此窗口接收输入" }
            else { "诊断窗口失去焦点；Windows WGI 可能暂停向本窗口提供输入，这不代表手柄模式改变" }.into();
        recorder.emit(event, None, true, None);
    }

    fn start(&self, directory: Result<PathBuf, String>) {
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

    fn synchronize(&self, identities: &mut HashMap<usize, DeviceIdentity>, gamepad: &Gamepad<'_>,
                   reconnect: bool, time: SystemTime, detail: &str) {
        let index = usize::from(gamepad.id());
        if !reconnect && identities.get(&index).is_some_and(|identity| identity.matches(gamepad)) {
            return;
        }
        let identity = DeviceIdentity::read(gamepad);
        let device = identity.device(index, gamepad);
        self.lock().connect(device, time, detail.into());
        identities.insert(index, identity);
    }

    fn read_inputs(&self) {
        // 创建、输入读取和销毁都在同一个后台线程中完成。
        // 不打开力反馈、控制状态、串口或其他应用程序。
        let mut gilrs = match GilrsBuilder::new().with_default_filters(false).with_force_feedback(false).build() {
            Ok(gilrs) => gilrs,
            Err(error) => {
                let mut recorder = self.lock();
                recorder.snapshot.supported = !matches!(&error, gilrs::Error::NotImplemented(_));
                recorder.snapshot.running = false;
                recorder.error(format!("手柄输入驱动初始化失败（{}）：{error}", input_api()));
                return;
            }
        };
        {
            let mut recorder = self.lock();
            recorder.snapshot.running = recorder.writer.is_some();
            let mut event = recorder.event("DriverReady", None, SystemTime::now());
            event.detail = format!("{}；只读，默认滤波关闭，振动支持关闭", input_api());
            recorder.emit(event, None, true, None);
        }
        let mut identities = HashMap::new();
        for (_, gamepad) in gilrs.gamepads() {
            self.synchronize(&mut identities, &gamepad, false, SystemTime::now(), "启动时已连接的设备快照");
        }
        while !self.stop.load(Ordering::Relaxed) {
            while let Some(event) = gilrs.next_event() {
                let index = usize::from(event.id);
                match event.event {
                    EventType::Connected => self.synchronize(&mut identities, &gilrs.gamepad(event.id), true,
                        event.time, "gilrs Connected"),
                    EventType::Disconnected => {
                        self.lock().disconnect(index, event.time, "gilrs Disconnected".into());
                        identities.remove(&index);
                    }
                    _ => {
                        let gamepad = gilrs.gamepad(event.id);
                        self.synchronize(&mut identities, &gamepad, false, event.time, "输入事件前检测到设备身份或 mapping 改变");
                        self.lock().input(index, RawInput::from_event(event.event, &gamepad), event.time);
                    }
                }
                if self.stop.load(Ordering::Relaxed) { break; }
            }
            for (_, gamepad) in gilrs.gamepads() {
                self.synchronize(&mut identities, &gamepad, false, SystemTime::now(), "枚举检测到设备身份或 mapping 改变");
            }
            gilrs.inc();
            thread::sleep(POLL_INTERVAL);
        }
        let mut recorder = self.lock();
        recorder.snapshot.running = false;
        let event = recorder.event("SessionStopped", None, SystemTime::now());
        recorder.emit(event, None, true, None);
    }
}

fn milliseconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
}

fn input_api() -> &'static str {
    if cfg!(target_os = "windows") { "gilrs / Windows Gaming Input (WGI)" }
    else if cfg!(target_os = "linux") { "gilrs / Linux evdev" }
    else if cfg!(target_os = "macos") { "gilrs / macOS IOKit" }
    else { "gilrs / platform backend (may be unsupported)" }
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
        // 启动时不抢占其他应用焦点；用户准备好后自行点回窗口采样 WGI 输入。
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

    fn device(index: usize, mapping: &str) -> DiagnosticDevice {
        DiagnosticDevice { key: String::new(), index, name: "USB test fixture".into(),
            uuid: "00000000000000000000000000000001".into(), vendor_id: Some(0x1234),
            product_id: Some(0x5678), mapping: mapping.into(), connected: true,
            axes: Vec::new(), buttons: Vec::new() }
    }

    fn axis(code: u32, value: f32) -> RawInput {
        RawInput { kind: "AxisChanged", code: Some(code), name: "Unknown".into(),
            value: Some(value), pressed: None, detail: "Unknown raw axis".into() }
    }

    fn button(code: u32, value: f32, pressed: bool) -> RawInput {
        RawInput { kind: if pressed { "ButtonPressed" } else { "ButtonReleased" }, code: Some(code),
            name: "Unknown".into(), value: Some(value), pressed: Some(pressed), detail: "Unknown raw button".into() }
    }

    fn lines(recorder: &Recorder) -> Vec<serde_json::Value> {
        fs::read_to_string(&recorder.snapshot.log_path).unwrap().lines()
            .map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    #[test]
    fn unknown_codes_and_zero_values_are_preserved_without_phantom_controls() {
        let directory = TempDirectory::new();
        let mut recorder = recorder(&directory);
        recorder.connect(device(2, "gilrs/Driver"), UNIX_EPOCH, "fixture".into());
        assert!(recorder.snapshot.devices[0].axes.is_empty());
        assert!(recorder.snapshot.devices[0].buttons.is_empty());
        recorder.input(2, axis(0xdead, 0.0), UNIX_EPOCH);
        recorder.input(2, axis(0xbeef, 0.25), UNIX_EPOCH);
        recorder.input(2, button(0xabcd, 1.0, true), UNIX_EPOCH);
        recorder.input(2, button(0xabcd, 0.0, false), UNIX_EPOCH);
        let pad = &recorder.snapshot.devices[0];
        assert_eq!(pad.axes.len(), 2);
        assert_eq!(pad.axes.iter().find(|axis| axis.code == 0xdead).unwrap().value, 0.0);
        assert_eq!(pad.buttons[0].name, "Unknown");
        assert_eq!(pad.buttons[0].code, 0xabcd);
        assert!(!pad.buttons[0].pressed);
        assert_eq!(lines(&recorder).last().unwrap()["code"], 0xabcd);
    }

    #[test]
    fn reconnect_and_mapping_changes_keep_old_identity_and_events() {
        let directory = TempDirectory::new();
        let mut recorder = recorder(&directory);
        recorder.connect(device(0, "first"), UNIX_EPOCH, "first connection".into());
        let first_key = recorder.snapshot.devices[0].key.clone();
        recorder.input(0, axis(91, 0.5), UNIX_EPOCH);
        recorder.disconnect(0, UNIX_EPOCH, "unplugged".into());
        recorder.connect(device(0, "first"), UNIX_EPOCH, "replugged".into());
        recorder.connect(device(0, "changed mapping"), UNIX_EPOCH, "mapping changed".into());
        assert_eq!(recorder.snapshot.devices.len(), 3);
        assert_ne!(recorder.snapshot.devices[1].key, first_key);
        assert_ne!(recorder.snapshot.devices[2].key, recorder.snapshot.devices[1].key);
        assert!(!recorder.snapshot.devices[0].connected);
        assert!(!recorder.snapshot.devices[1].connected);
        assert!(recorder.snapshot.devices[2].connected);
        assert!(recorder.snapshot.events.iter().any(|event| event.device_key == first_key && event.code == Some(91)));
        let saved = lines(&recorder);
        let connection = saved.iter().find(|line| line["kind"] == "Connected").unwrap();
        assert_eq!(connection["device"]["vendorId"], 0x1234);
        assert_eq!(connection["device"]["productId"], 0x5678);
        assert_eq!(connection["device"]["mapping"], "first");
    }

    #[test]
    fn stages_and_pause_keep_live_values_without_recording_paused_input() {
        let directory = TempDirectory::new();
        let mut recorder = recorder(&directory);
        recorder.connect(device(0, "fixture"), UNIX_EPOCH, String::new());
        recorder.mark("准备按 Analog".into()).unwrap();
        recorder.pause(true).unwrap();
        let count = lines(&recorder).len();
        let sequence = recorder.snapshot.sequence;
        recorder.input(0, axis(721, -0.8), UNIX_EPOCH);
        recorder.input(0, button(722, 1.0, true), UNIX_EPOCH);
        assert_eq!(recorder.snapshot.sequence, sequence);
        assert_eq!(lines(&recorder).len(), count);
        assert_eq!(recorder.snapshot.devices[0].axes[0].value, -0.8);
        assert!(recorder.snapshot.devices[0].buttons[0].pressed);
        recorder.mark("Analog LED 由用户观察；未推断模式".into()).unwrap();
        assert_eq!(lines(&recorder).last().unwrap()["kind"], "Stage");
        recorder.pause(false).unwrap();
        recorder.input(0, axis(721, 0.2), UNIX_EPOCH);
        assert_eq!(lines(&recorder).last().unwrap()["stage"], "Analog LED 由用户观察；未推断模式");
        assert!(!lines(&recorder).iter().any(|line| line["kind"] == "AxisChanged" && line["value"] == -0.8));
    }

    #[test]
    fn jsonl_keeps_all_events_while_snapshot_only_keeps_two_hundred() {
        let directory = TempDirectory::new();
        let mut recorder = recorder(&directory);
        recorder.connect(device(0, "fixture"), UNIX_EPOCH, String::new());
        for number in 0..350 {
            recorder.input(0, axis(44, number as f32 / 350.0), UNIX_EPOCH + Duration::from_millis(number));
        }
        let saved = lines(&recorder);
        assert_eq!(saved.len(), 352);
        assert_eq!(saved[0]["kind"], "Session");
        assert_eq!(saved[0]["session"]["defaultFilters"], false);
        assert_eq!(saved[0]["session"]["forceFeedback"], false);
        assert_eq!(saved[0]["session"]["logPath"], recorder.snapshot.log_path);
        assert_eq!(recorder.snapshot.events.len(), 200);
        for (index, line) in saved.iter().enumerate() {
            assert_eq!(line["sequence"].as_u64().unwrap(), index as u64 + 1);
        }
        assert!(PathBuf::from(&recorder.snapshot.log_path).is_absolute());
        assert_eq!(saved.last().unwrap()["timeMs"], 349);
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
        recorder.connect(device(0, "fixture"), UNIX_EPOCH, String::new());
        recorder.writer = Some(Box::new(FailingWriter));
        recorder.snapshot.running = true;
        recorder.input(0, axis(3, 0.25), UNIX_EPOCH);
        assert!(recorder.writer.is_none());
        assert!(!recorder.snapshot.running);
        assert!(recorder.snapshot.error.contains("日志写入失败"));
        assert!(recorder.snapshot.events.iter().any(|event| event.kind == "Error"));
        recorder.input(0, axis(3, 0.75), UNIX_EPOCH);
        assert_eq!(recorder.snapshot.devices[0].axes[0].value, 0.75);
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
