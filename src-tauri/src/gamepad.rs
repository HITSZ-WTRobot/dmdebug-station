use crate::native::{BodyVelocity, NativeState};
#[cfg(windows)]
use crate::input::{winmm::Reader, InputDevice};
use serde::Serialize;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
const SAMPLE_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(windows)]
const SNAPSHOT_INTERVAL: Duration = Duration::from_millis(100);
#[cfg(windows)]
const INPUT_LEASE: Duration = Duration::from_millis(250);
const START_DEBOUNCE: Duration = Duration::from_millis(40);
const DEADZONE: f32 = 0.12;
const TRANSLATION_LIMIT: f32 = 0.4;

#[derive(Clone, Default, Serialize)]
pub struct PadButton {
    pub value: f32,
    pub pressed: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PadView {
    pub key: String,
    pub id: String,
    pub index: usize,
    pub mapping: String,
    pub timestamp: f64,
    pub connected: bool,
    pub axes: Vec<f32>,
    pub buttons: Vec<PadButton>,
    // 只保留真实能力编号，不能用数组位置补齐缺失的控制轴。
    pub axis_codes: Vec<u32>,
    pub button_codes: Vec<u32>,
    #[serde(skip)]
    generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PadSnapshot {
    pub supported: bool,
    pub error: String,
    pub pads: Vec<PadView>,
    pub selected_key: String,
    pub armed: bool,
    pub neutral: bool,
    pub released: bool,
    pub start_pressed: bool,
    pub input_target: BodyVelocity,
    pub target: BodyVelocity,
    pub phase: String,
    pub message: String,
}

impl Default for PadSnapshot {
    fn default() -> Self {
        Self {
            supported: false,
            error: String::new(),
            pads: Vec::new(),
            selected_key: String::new(),
            armed: false,
            neutral: false,
            released: false,
            start_pressed: false,
            input_target: BodyVelocity::default(),
            target: BodyVelocity::default(),
            phase: "off".into(),
            message: "等待 WinMM 手柄输入；选择设备不会自动使能。".into(),
        }
    }
}

#[derive(Default)]
struct StartButton {
    candidate: Option<(bool, Instant)>,
    pressed: bool,
    confirmed: bool,
}

impl StartButton {
    fn update(&mut self, pressed: bool, now: Instant) -> bool {
        let since = match self.candidate {
            Some((candidate, since)) if candidate == pressed => since,
            _ => {
                self.candidate = Some((pressed, now));
                now
            }
        };
        if now.saturating_duration_since(since) < START_DEBOUNCE {
            return false;
        }
        let rising = pressed && !self.pressed;
        self.pressed = pressed;
        self.confirmed = true;
        rising
    }
}

#[derive(Default)]
struct Toggle {
    // Reader 提供稳定连接代次；采样时不序列化身份或克隆设备 key。
    identity: Option<(usize, u64)>,
    armed: bool,
    neutral_seen: bool,
    released: bool,
    button: StartButton,
}

#[derive(Debug, PartialEq)]
enum Action {
    None,
    Start,
    Stop,
    Invalidated,
}

impl Toggle {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn step(&mut self, identity: (usize, u64), neutral: bool, pressed: bool, now: Instant) -> Action {
        if self.identity.is_some_and(|previous| previous != identity) {
            self.reset();
            return Action::Invalidated;
        }
        self.identity = Some(identity);
        self.neutral_seen |= neutral;
        let rising = self.button.update(pressed, now);
        if self.button.confirmed && !self.button.pressed {
            self.released = true;
        }
        if rising && self.released {
            if self.armed {
                self.reset();
                return Action::Stop;
            }
            if neutral && self.neutral_seen {
                self.armed = true;
                return Action::Start;
            }
        }
        Action::None
    }
}

#[derive(Default)]
struct Shared {
    snapshot: PadSnapshot,
    toggle: Toggle,
    native: Option<NativeState>,
    started: bool,
    visible: bool,
    frontend_focused: bool,
    window_focused: bool,
}

impl Shared {
    fn permitted(&self) -> bool {
        self.visible && self.frontend_focused && self.window_focused
    }

    fn has_control(&self) -> bool {
        self.toggle.armed || self.native.as_ref().is_some_and(|native| {
            matches!(native.gamepad_state().phase.as_str(), "enabling" | "active")
        })
    }

    fn revoke(&mut self, reason: &str, request_stop: bool) -> Result<(), String> {
        self.toggle.reset();
        self.snapshot.armed = false;
        self.snapshot.neutral = false;
        self.snapshot.released = false;
        self.snapshot.start_pressed = false;
        self.snapshot.target = BodyVelocity::default();
        self.snapshot.message = reason.into();
        if request_stop {
            let result = self.native.as_ref().ok_or_else(|| "原生通信服务未启动".to_string())
                .and_then(|native| native.gamepad_stop(reason));
            if let Some(native) = self.native.as_ref() {
                self.snapshot.phase = native.gamepad_state().phase;
            }
            if let Err(error) = result {
                self.snapshot.error = format!("停止请求失败：{error}。不能确认物理停止，请使用硬件急停。");
                return Err(error);
            }
        }
        Ok(())
    }

    fn fail_driver(&mut self, error: String) {
        let stop = self.has_control();
        let _ = self.revoke("WinMM 手柄输入不可用，遥控已撤销；不会自动恢复。", stop);
        self.snapshot.supported = false;
        self.snapshot.selected_key.clear();
        self.snapshot.input_target = BodyVelocity::default();
        self.snapshot.pads.clear();
        if self.snapshot.error.is_empty() {
            self.snapshot.error = error;
        } else {
            self.snapshot.error = format!("{error}；{}", self.snapshot.error);
        }
    }
}

#[derive(Clone, Default)]
pub struct NativeGamepadState {
    inner: Arc<Mutex<Shared>>,
}

impl NativeGamepadState {
    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn start(&self, app: AppHandle, native: NativeState) {
        {
            let mut shared = self.lock();
            if shared.started {
                return;
            }
            shared.started = true;
            shared.native = Some(native);
            shared.window_focused = app.get_webview_window("main")
                .and_then(|window| window.is_focused().ok()).unwrap_or(false);
        }
        let state = self.clone();
        let failure = self.clone();
        if let Err(error) = thread::Builder::new().name("native-gamepad".into()).spawn(move || {
            // WinMM 句柄及采样缓存只属于此线程；通信仍由 NativeState 唯一 actor 执行。
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| state.run(app.clone()))).is_err() {
                let snapshot = {
                    let mut shared = state.lock();
                    shared.fail_driver("原生手柄输入线程异常退出".into());
                    shared.snapshot.clone()
                };
                let _ = app.emit("native-gamepad", snapshot);
            }
        }) {
            failure.lock().fail_driver(format!("无法启动原生手柄线程：{error}"));
        }
    }

    pub fn set_window_focus(&self, focused: bool) {
        let mut shared = self.lock();
        let permitted = shared.permitted();
        let lost = shared.window_focused && !focused;
        shared.window_focused = focused;
        if lost || (!focused && shared.toggle.armed) {
            let stop = shared.has_control();
            let _ = shared.revoke("原生窗口失焦或销毁，遥控关闭；恢复焦点不会自动使能。", stop);
        } else if !permitted && shared.permitted() {
            // 失焦期间的稳定释放不能成为恢复焦点后的开启许可。
            shared.toggle.reset();
            shared.snapshot.released = false;
            shared.snapshot.start_pressed = false;
        }
    }

    fn select(&self, device_key: String) -> Result<(), String> {
        let mut shared = self.lock();
        let validation = if !shared.snapshot.supported {
            Err(if shared.snapshot.error.is_empty() { "WinMM 手柄输入尚不可用".into() } else { shared.snapshot.error.clone() })
        } else {
            shared.snapshot.pads.iter().find(|pad| pad.key == device_key && pad.connected)
                .ok_or_else(|| "手柄身份已变化或未连接，请重新明确选择".into())
                .and_then(|pad| fixed_layout(pad).map(|_| ()))
        };
        if let Err(error) = validation {
            let stop = shared.has_control();
            let stopped = shared.revoke("设备选择无效，本地遥控已关闭。", stop);
            shared.snapshot.selected_key.clear();
            shared.snapshot.input_target = BodyVelocity::default();
            shared.snapshot.error = match stopped {
                Ok(()) => error.clone(),
                Err(_) => format!("{error}；{}", shared.snapshot.error),
            };
            return Err(error);
        }
        // 无 COM 时仍可选择设备并观察输入；选择本身不请求使能。
        let stop = shared.has_control();
        shared.revoke("设备已选择；三轴回中并稳定释放 Start 后，再按下开启。", stop)?;
        shared.snapshot.selected_key = device_key;
        shared.snapshot.input_target = BodyVelocity::default();
        shared.snapshot.error.clear();
        Ok(())
    }

    fn context(&self, visible: bool, focused: bool) -> Result<(), String> {
        let mut shared = self.lock();
        let permitted = shared.permitted();
        shared.visible = visible;
        shared.frontend_focused = focused;
        // 前端只能收紧许可，不能覆盖真实 WindowEvent 的失焦状态。
        if permitted && !shared.permitted() {
            let stop = shared.has_control();
            shared.revoke("已离页、隐藏或前端失焦，遥控关闭；不会自动恢复。", stop)?;
        } else if !permitted && shared.permitted() {
            shared.toggle.reset();
            shared.snapshot.released = false;
            shared.snapshot.start_pressed = false;
        }
        Ok(())
    }

    fn stop(&self) -> Result<(), String> {
        // 保留明确选择，但清除稳定释放和旧边沿；即使本地 off 也请求九设备失能。
        self.lock().revoke("操作员请求全设备失能；等待通信应答，不能保证物理停止。", true)
    }

    #[cfg(not(windows))]
    fn run(&self, app: AppHandle) {
        let snapshot = {
            let mut shared = self.lock();
            shared.fail_driver("当前平台不支持 Windows WinMM 原生手柄输入".into());
            shared.snapshot.clone()
        };
        let _ = app.emit("native-gamepad", snapshot);
    }

    #[cfg(windows)]
    fn run(&self, app: AppHandle) {
        let mut reader = match Reader::new() {
            Ok(reader) => reader,
            Err(error) => {
                let snapshot = {
                    let mut shared = self.lock();
                    shared.fail_driver(format!("WinMM 输入初始化失败：{error}"));
                    shared.snapshot.clone()
                };
                let _ = app.emit("native-gamepad", snapshot);
                return;
            }
        };
        {
            let mut shared = self.lock();
            shared.snapshot.supported = true;
            shared.snapshot.message = "WinMM 输入已启动；请选择设备，固定使用左杆、右杆 X 和 Start。".into();
        }
        let clock = Instant::now();
        let mut last_sample = clock;
        let mut next_sample = clock;
        let mut next_snapshot = clock;
        loop {
            let now = Instant::now();
            let snapshot = {
                let mut shared = self.lock();
                if now.duration_since(last_sample) > INPUT_LEASE
                    && (!shared.snapshot.selected_key.is_empty() || shared.has_control()) {
                    let stop = shared.has_control();
                    let _ = shared.revoke("原生输入采样超过 250 ms 未更新，遥控关闭且旧速度已丢弃。", stop);
                }
                if let Err(error) = update_pads(&mut reader, &mut shared.snapshot.pads, now.duration_since(clock).as_secs_f64() * 1000.0) {
                    shared.fail_driver(error);
                    let _ = app.emit("native-gamepad", shared.snapshot.clone());
                    return;
                }
                sample_control(&mut shared, now);
                if now >= next_snapshot {
                    next_snapshot = now + SNAPSHOT_INTERVAL;
                    Some(shared.snapshot.clone())
                } else {
                    None
                }
            };
            if let Some(snapshot) = snapshot {
                let _ = app.emit("native-gamepad", snapshot);
            }
            last_sample = now;
            next_sample += SAMPLE_INTERVAL;
            let after_work = Instant::now();
            if next_sample > after_work {
                thread::sleep(next_sample - after_work);
            } else {
                // 不追赶积压周期，也不重放旧输入。
                next_sample = after_work;
            }
        }
    }
}

#[cfg(windows)]
fn update_pad(pad: &mut PadView, device: &InputDevice, timestamp: f64) {
    if pad.key.is_empty() || pad.generation != device.generation || pad.index != device.index {
        pad.key.clone_from(&device.key);
        pad.id.clone_from(&device.name);
        pad.mapping.clone_from(&device.mapping);
        pad.index = device.index;
        pad.generation = device.generation;
        pad.axis_codes.clear();
        pad.axis_codes.extend(device.axes.iter().map(|axis| axis.code));
        pad.button_codes.clear();
        pad.button_codes.extend(device.buttons.iter().map(|button| button.code));
        pad.axes.resize(device.axes.len(), 0.0);
        pad.buttons.resize(device.buttons.len(), PadButton::default());
    }
    // 稳定代次直接覆盖既有缓存，不复制身份字符串或重新分配轴/按钮数组。
    for (value, axis) in pad.axes.iter_mut().zip(&device.axes) {
        *value = axis.value;
    }
    for (value, button) in pad.buttons.iter_mut().zip(&device.buttons) {
        value.value = button.value;
        value.pressed = button.pressed;
    }
    pad.connected = device.connected;
    pad.timestamp = timestamp;
}

#[cfg(windows)]
fn update_pads(reader: &mut Reader, pads: &mut Vec<PadView>, timestamp: f64) -> Result<(), String> {
    for pad in pads.iter_mut() {
        pad.connected = false;
    }
    for index in 0..reader.slot_count() {
        let Some(device) = reader.read(index)? else { continue };
        let position = pads.iter().position(|pad| pad.index == device.index).unwrap_or_else(|| {
            pads.push(PadView::default());
            pads.len() - 1
        });
        update_pad(&mut pads[position], device, timestamp);
    }
    pads.retain(|pad| pad.connected);
    Ok(())
}

fn fixed_layout(pad: &PadView) -> Result<([usize; 3], usize), String> {
    let mut axes = [0; 3];
    for (code, position) in axes.iter_mut().enumerate() {
        *position = pad.axis_codes.iter().position(|observed| *observed == code as u32)
            .filter(|index| *index < pad.axes.len())
            .ok_or_else(|| format!("设备缺少固定控制轴 code{code}（X/Y/Z）"))?;
    }
    let button = pad.button_codes.iter().position(|code| *code == 9)
        .filter(|index| *index < pad.buttons.len())
        .ok_or_else(|| "设备缺少 Start（按钮10/code9）".to_string())?;
    Ok((axes, button))
}

struct Input {
    target: BodyVelocity,
    neutral: bool,
    pressed: bool,
}

fn remap_deadzone(value: f32) -> f32 {
    let magnitude = value.abs().min(1.0);
    if magnitude <= DEADZONE { 0.0 } else { value.signum() * (magnitude - DEADZONE) / (1.0 - DEADZONE) }
}

fn read_input(pad: &PadView) -> Result<Input, String> {
    if !pad.connected {
        return Err("手柄已断开".into());
    }
    let ([left_x, left_y, right_x], start) = fixed_layout(pad)?;
    let x = pad.axes[left_x];
    let y = pad.axes[left_y];
    let rotation = pad.axes[right_x];
    // 右杆 Y 和其它按钮完全不参与输出、回中或输入合法性门禁。
    if [x, y, rotation].iter().any(|value| !value.is_finite() || !(-1.0..=1.0).contains(value)) {
        return Err("控制轴输入缺失、越界或包含非有限值".into());
    }
    let button = &pad.buttons[start];
    if !button.value.is_finite() || !(0.0..=1.0).contains(&button.value) {
        return Err("Start 输入缺失、越界或包含非有限值".into());
    }
    let magnitude = x.hypot(y);
    let speed = remap_deadzone(magnitude) * TRANSLATION_LIMIT;
    let mut target = BodyVelocity {
        vx: if magnitude <= DEADZONE { 0.0 } else { -y / magnitude * speed },
        vy: if magnitude <= DEADZONE { 0.0 } else { -x / magnitude * speed },
        wz: -remap_deadzone(rotation) * 360.0,
    };
    // 浮点舍入也不能使斜推合成速度超过手柄平移上限。
    let actual_speed = target.vx.hypot(target.vy);
    if actual_speed > TRANSLATION_LIMIT {
        let scale = TRANSLATION_LIMIT * (1.0 - f32::EPSILON) / actual_speed;
        target.vx *= scale;
        target.vy *= scale;
    }
    Ok(Input {
        target,
        neutral: magnitude <= DEADZONE && rotation.abs() <= DEADZONE,
        pressed: button.pressed || button.value >= 0.5,
    })
}

fn sample_control(shared: &mut Shared, now: Instant) {
    let native = shared.native.clone();
    if let Some(native) = native.as_ref() {
        let control = native.gamepad_state();
        shared.snapshot.phase = control.phase;
        if shared.toggle.armed && shared.snapshot.phase != "active" && shared.snapshot.phase != "enabling" {
            let _ = shared.revoke("通信层已退出遥控；需回中、稳定释放后重新按下，绝不自动恢复。", false);
        }
        if !control.message.is_empty() && !shared.toggle.armed {
            shared.snapshot.message = control.message;
        }
    }
    if shared.snapshot.selected_key.is_empty() {
        shared.snapshot.input_target = BodyVelocity::default();
        return;
    }
    let Some(pad) = shared.snapshot.pads.iter().find(|pad| pad.key == shared.snapshot.selected_key && pad.connected) else {
        let stop = shared.has_control();
        let _ = shared.revoke("手柄断开或连接身份改变；请重新明确选择设备。", stop);
        shared.snapshot.selected_key.clear();
        shared.snapshot.input_target = BodyVelocity::default();
        return;
    };
    let identity = (pad.index, pad.generation);
    let input = match read_input(pad) {
        Ok(input) => input,
        Err(error) => {
            let stop = shared.has_control();
            let stopped = shared.revoke("无效手柄输入，本地遥控已关闭。", stop);
            shared.snapshot.selected_key.clear();
            shared.snapshot.input_target = BodyVelocity::default();
            shared.snapshot.error = match stopped {
                Ok(()) => error,
                Err(_) => format!("{error}；{}", shared.snapshot.error),
            };
            return;
        }
    };
    shared.snapshot.input_target = input.target.clone();
    shared.snapshot.neutral = input.neutral;
    if !shared.permitted() {
        // 未获焦点时仍显示稳定 Start 状态，但不累计释放/回中许可。
        shared.toggle.button.update(input.pressed, now);
        shared.snapshot.start_pressed = shared.toggle.button.pressed;
        return;
    }
    let action = shared.toggle.step(identity, input.neutral, input.pressed, now);
    match action {
        Action::Start => {
            let result = native.as_ref().ok_or_else(|| "原生通信服务未启动".to_string())
                .and_then(|native| native.gamepad_start());
            if let Err(error) = result {
                let _ = shared.revoke("开启失败，本地遥控已关闭并请求全设备失能。", true);
                shared.snapshot.error = format!("开启失败：{error}；{}", shared.snapshot.error);
            } else {
                shared.snapshot.error.clear();
                shared.snapshot.message = "仅请求使能底盘 0x40，等待新反馈确认。".into();
            }
        }
        Action::Stop => {
            let _ = shared.revoke("Start 关闭，已请求全设备失能；等待真实应答。", true);
        }
        Action::Invalidated => {
            let stop = shared.has_control();
            let _ = shared.revoke("连接身份已变化，本地遥控已关闭；请重新选择设备。", stop);
            shared.snapshot.selected_key.clear();
            shared.snapshot.input_target = BodyVelocity::default();
        }
        Action::None => {}
    }
    if shared.toggle.armed {
        if let Some(native) = native.as_ref() {
            if let Err(error) = native.gamepad_update(input.target.clone()) {
                let _ = shared.revoke("目标更新失败，已请求全设备失能。", true);
                shared.snapshot.error = format!("目标更新失败：{error}；{}", shared.snapshot.error);
            }
        }
    }
    if let Some(native) = native {
        let control = native.gamepad_state();
        shared.snapshot.phase = control.phase;
        if !control.message.is_empty() {
            shared.snapshot.message = control.message;
        }
    }
    shared.snapshot.armed = shared.toggle.armed;
    shared.snapshot.released = shared.toggle.released;
    shared.snapshot.start_pressed = shared.toggle.button.pressed;
    shared.snapshot.target = if shared.toggle.armed { input.target } else { BodyVelocity::default() };
}

#[tauri::command]
pub fn native_gamepad_snapshot(state: State<'_, NativeGamepadState>) -> PadSnapshot {
    state.lock().snapshot.clone()
}

#[tauri::command]
pub fn native_gamepad_select(state: State<'_, NativeGamepadState>, device_key: String) -> Result<(), String> {
    state.select(device_key)
}

#[tauri::command]
pub fn native_gamepad_context(state: State<'_, NativeGamepadState>, visible: bool, focused: bool) -> Result<(), String> {
    state.context(visible, focused)
}

#[tauri::command]
pub fn native_gamepad_stop(state: State<'_, NativeGamepadState>) -> Result<(), String> {
    state.stop()
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: (usize, u64) = (0, 1);

    fn pad() -> PadView {
        PadView {
            key: "winmm:0:1".into(),
            id: "普通 USB 手柄".into(),
            mapping: "WinMM".into(),
            connected: true,
            axes: vec![0.0; 4],
            buttons: vec![PadButton::default(); 10],
            axis_codes: vec![0, 1, 2, 3],
            button_codes: (0..10).collect(),
            generation: 1,
            ..PadView::default()
        }
    }

    fn at(base: Instant, millis: u64) -> Instant {
        base + Duration::from_millis(millis)
    }

    fn arm(toggle: &mut Toggle, base: Instant) {
        assert_eq!(toggle.step(IDENTITY, true, false, base), Action::None);
        assert_eq!(toggle.step(IDENTITY, true, false, at(base, 40)), Action::None);
        assert!(toggle.released);
        assert_eq!(toggle.step(IDENTITY, true, true, at(base, 60)), Action::None);
        assert_eq!(toggle.step(IDENTITY, true, true, at(base, 100)), Action::Start);
    }

    fn selected_shared() -> Shared {
        let pad = pad();
        let mut shared = Shared::default();
        shared.native = Some(NativeState::default());
        shared.visible = true;
        shared.frontend_focused = true;
        shared.window_focused = true;
        shared.snapshot.supported = true;
        shared.snapshot.selected_key = pad.key.clone();
        shared.snapshot.pads.push(pad);
        shared
    }

    fn press(shared: &mut Shared, pressed: bool) {
        shared.snapshot.pads[0].buttons[9].pressed = pressed;
        shared.snapshot.pads[0].buttons[9].value = if pressed { 1.0 } else { 0.0 };
    }

    #[test]
    fn proportional_directions_and_combined_limits() {
        let mut pad = pad();
        pad.axes = vec![0.0, -0.5, 0.5, 1.0];
        let half = read_input(&pad).unwrap();
        assert!((half.target.vx - 0.4 * 0.38 / 0.88).abs() < 0.00001);
        assert!((half.target.wz + 360.0 * 0.38 / 0.88).abs() < 0.00001);
        assert_eq!(half.target.vy, 0.0);
        pad.axes = vec![1.0, -1.0, -1.0, -1.0];
        let full = read_input(&pad).unwrap();
        assert!(full.target.vx > 0.0 && full.target.vy < 0.0);
        assert!(full.target.vx.hypot(full.target.vy) <= 0.4);
        assert!((full.target.vx.hypot(full.target.vy) - 0.4).abs() < 0.00001);
        assert_eq!(full.target.wz, 360.0);
        for x in -10..=10 {
            for y in -10..=10 {
                pad.axes[0] = x as f32 / 10.0;
                pad.axes[1] = y as f32 / 10.0;
                let input = read_input(&pad).unwrap();
                assert!(input.target.vx.hypot(input.target.vy) <= 0.4);
                assert!(input.target.wz.abs() <= 360.0);
            }
        }
    }

    #[test]
    fn right_y_and_other_buttons_do_not_affect_control_or_neutral() {
        let mut pad = pad();
        pad.axes[0] = 0.08;
        pad.axes[1] = 0.08;
        pad.axes[2] = 0.1;
        pad.axes[3] = f32::NAN;
        for button in &mut pad.buttons[..9] {
            button.pressed = true;
            button.value = f32::INFINITY;
        }
        let input = read_input(&pad).unwrap();
        assert!(input.neutral && !input.pressed);
        assert_eq!(input.target.vx, 0.0);
        assert_eq!(input.target.vy, 0.0);
        assert_eq!(input.target.wz, 0.0);
        pad.buttons[9].pressed = true;
        assert!(read_input(&pad).unwrap().pressed);
    }

    #[test]
    fn fixed_codes_are_not_array_offsets_or_filled_missing_axes() {
        let mut pad = pad();
        pad.axis_codes = vec![3, 2, 0, 1];
        pad.axes = vec![1.0, 0.5, 0.0, -1.0];
        pad.button_codes.reverse();
        pad.buttons[0].pressed = true;
        let input = read_input(&pad).unwrap();
        assert_eq!(input.target.vx, 0.4);
        assert!(input.target.wz < 0.0 && input.pressed);
        pad.axis_codes[1] = 4;
        assert!(read_input(&pad).is_err());
        pad.axis_codes[1] = 2;
        pad.button_codes[0] = 10;
        assert!(read_input(&pad).is_err());
    }

    #[test]
    fn invalid_control_values_and_disconnection_are_rejected() {
        let mut pad = pad();
        pad.axes[2] = f32::NAN;
        assert!(read_input(&pad).is_err());
        pad.axes[2] = 1.01;
        assert!(read_input(&pad).is_err());
        pad.axes[2] = 0.0;
        pad.buttons[9].value = f32::INFINITY;
        assert!(read_input(&pad).is_err());
        pad.buttons[9].value = 0.0;
        pad.connected = false;
        assert!(read_input(&pad).is_err());
    }

    #[test]
    fn stable_release_then_stable_press_required_and_long_hold_toggles_once() {
        let base = Instant::now();
        let mut toggle = Toggle::default();
        assert_eq!(toggle.step(IDENTITY, true, true, base), Action::None);
        assert_eq!(toggle.step(IDENTITY, true, true, at(base, 100)), Action::None);
        assert!(!toggle.released && !toggle.armed && toggle.button.pressed);
        assert_eq!(toggle.step(IDENTITY, true, false, at(base, 120)), Action::None);
        assert_eq!(toggle.step(IDENTITY, true, false, at(base, 140)), Action::None);
        assert!(!toggle.released);
        assert_eq!(toggle.step(IDENTITY, true, false, at(base, 160)), Action::None);
        assert!(toggle.released && !toggle.button.pressed);
        assert_eq!(toggle.step(IDENTITY, true, true, at(base, 180)), Action::None);
        assert_eq!(toggle.step(IDENTITY, true, true, at(base, 219)), Action::None);
        assert_eq!(toggle.step(IDENTITY, true, true, at(base, 220)), Action::Start);
        for millis in (240..=1000).step_by(20) {
            assert_eq!(toggle.step(IDENTITY, false, true, at(base, millis)), Action::None);
        }
        assert!(toggle.armed);
    }

    #[test]
    fn short_press_and_release_bounce_do_not_toggle_or_create_a_second_edge() {
        let base = Instant::now();
        let mut toggle = Toggle::default();
        arm(&mut toggle, base);
        for (millis, pressed) in [(120, false), (130, true), (140, false), (160, true), (200, true)] {
            assert_eq!(toggle.step(IDENTITY, false, pressed, at(base, millis)), Action::None);
        }
        assert!(toggle.armed && toggle.button.pressed);
        assert_eq!(toggle.step(IDENTITY, false, false, at(base, 220)), Action::None);
        assert_eq!(toggle.step(IDENTITY, false, false, at(base, 260)), Action::None);
        assert_eq!(toggle.step(IDENTITY, false, true, at(base, 280)), Action::None);
        assert_eq!(toggle.step(IDENTITY, false, false, at(base, 300)), Action::None);
        assert_eq!(toggle.step(IDENTITY, false, false, at(base, 340)), Action::None);
        assert!(toggle.armed);
        assert_eq!(toggle.step(IDENTITY, false, true, at(base, 360)), Action::None);
        assert_eq!(toggle.step(IDENTITY, false, true, at(base, 400)), Action::Stop);
        assert!(!toggle.armed && !toggle.released);
        assert_eq!(toggle.step(IDENTITY, true, true, at(base, 420)), Action::None);
        assert_eq!(toggle.step(IDENTITY, true, true, at(base, 460)), Action::None);
        assert!(!toggle.armed && !toggle.released);
        toggle.step(IDENTITY, true, false, at(base, 480));
        toggle.step(IDENTITY, true, false, at(base, 520));
        toggle.step(IDENTITY, true, true, at(base, 540));
        assert_eq!(toggle.step(IDENTITY, true, true, at(base, 580)), Action::Start);
    }

    #[test]
    fn off_center_start_is_consumed_and_stopping_does_not_require_center() {
        let base = Instant::now();
        let mut toggle = Toggle::default();
        toggle.step(IDENTITY, true, false, base);
        toggle.step(IDENTITY, true, false, at(base, 40));
        toggle.step(IDENTITY, false, true, at(base, 60));
        assert_eq!(toggle.step(IDENTITY, false, true, at(base, 100)), Action::None);
        assert_eq!(toggle.step(IDENTITY, true, true, at(base, 200)), Action::None);
        assert!(!toggle.armed);
        toggle.step(IDENTITY, true, false, at(base, 220));
        toggle.step(IDENTITY, true, false, at(base, 260));
        toggle.step(IDENTITY, true, true, at(base, 280));
        assert_eq!(toggle.step(IDENTITY, true, true, at(base, 320)), Action::Start);
        toggle.step(IDENTITY, false, false, at(base, 340));
        toggle.step(IDENTITY, false, false, at(base, 380));
        toggle.step(IDENTITY, false, true, at(base, 400));
        assert_eq!(toggle.step(IDENTITY, false, true, at(base, 440)), Action::Stop);
    }

    #[test]
    fn reconnect_clears_selection_and_does_not_reuse_previous_edge() {
        let base = Instant::now();
        let mut shared = selected_shared();
        arm(&mut shared.toggle, base);
        shared.snapshot.armed = true;
        shared.snapshot.pads[0].generation = 2;
        shared.snapshot.pads[0].key = "winmm:0:2".into();
        sample_control(&mut shared, at(base, 120));
        assert!(shared.snapshot.selected_key.is_empty());
        assert!(!shared.toggle.armed && !shared.toggle.released);
        assert_eq!(shared.snapshot.target.vx, 0.0);
        let mut toggle = Toggle::default();
        arm(&mut toggle, base);
        assert_eq!(toggle.step((0, 2), true, true, at(base, 120)), Action::Invalidated);
        assert!(!toggle.armed && !toggle.released);
    }

    #[test]
    fn selecting_without_com_can_leave_and_restore_focus_without_stop_errors() {
        let base = Instant::now();
        let state = NativeGamepadState::default();
        *state.lock() = selected_shared();
        state.select("winmm:0:1".into()).unwrap();
        state.context(false, false).unwrap();
        state.set_window_focus(false);
        state.context(true, true).unwrap();
        assert!(!state.lock().permitted());
        state.set_window_focus(true);
        let mut shared = state.lock();
        sample_control(&mut shared, base);
        assert!(shared.permitted() && !shared.has_control());
        assert!(shared.snapshot.error.is_empty());
        assert_eq!(shared.snapshot.selected_key, "winmm:0:1");
        assert!(!shared.toggle.armed && !shared.toggle.released);
    }

    #[test]
    fn focus_loss_and_restore_require_a_new_stable_release() {
        let base = Instant::now();
        let state = NativeGamepadState::default();
        *state.lock() = selected_shared();
        arm(&mut state.lock().toggle, base);
        state.set_window_focus(false);
        state.context(true, true).unwrap();
        assert!(!state.lock().permitted());
        state.set_window_focus(true);
        let mut shared = state.lock();
        press(&mut shared, true);
        sample_control(&mut shared, at(base, 200));
        sample_control(&mut shared, at(base, 240));
        assert!(!shared.toggle.armed && !shared.toggle.released);
        assert_eq!(shared.snapshot.selected_key, "winmm:0:1");
        assert!(shared.snapshot.start_pressed);
    }

    #[test]
    fn preview_works_without_serial_and_start_failure_keeps_target_zero() {
        let base = Instant::now();
        let state = NativeGamepadState::default();
        *state.lock() = selected_shared();
        state.select("winmm:0:1".into()).unwrap();
        let mut shared = state.lock();
        shared.snapshot.pads[0].axes[1] = -1.0;
        sample_control(&mut shared, base);
        assert_eq!(shared.snapshot.input_target.vx, 0.4);
        assert_eq!(shared.snapshot.target.vx, 0.0);
        assert!(!shared.snapshot.armed);
        shared.snapshot.pads[0].axes[1] = 0.0;
        sample_control(&mut shared, at(base, 40));
        press(&mut shared, true);
        sample_control(&mut shared, at(base, 60));
        sample_control(&mut shared, at(base, 100));
        assert!(!shared.toggle.armed && !shared.snapshot.armed && !shared.toggle.released);
        assert_eq!(shared.snapshot.selected_key, "winmm:0:1");
        assert_eq!(shared.snapshot.target.vx, 0.0);
        sample_control(&mut shared, at(base, 200));
        assert!(!shared.toggle.armed);
    }

    #[test]
    fn explicit_stop_preserves_selection_but_clears_old_edges_even_on_failure() {
        let base = Instant::now();
        let state = NativeGamepadState::default();
        *state.lock() = selected_shared();
        arm(&mut state.lock().toggle, base);
        assert!(state.stop().is_err());
        let mut shared = state.lock();
        assert_eq!(shared.snapshot.selected_key, "winmm:0:1");
        assert!(!shared.toggle.armed && !shared.toggle.released);
        press(&mut shared, true);
        sample_control(&mut shared, at(base, 200));
        sample_control(&mut shared, at(base, 240));
        assert!(!shared.toggle.armed && !shared.toggle.released);
        press(&mut shared, false);
        sample_control(&mut shared, at(base, 260));
        sample_control(&mut shared, at(base, 300));
        assert!(shared.toggle.released);
    }

    #[test]
    fn communication_revocation_cannot_be_revived_by_a_held_start() {
        let base = Instant::now();
        let mut shared = selected_shared();
        arm(&mut shared.toggle, base);
        shared.snapshot.armed = true;
        press(&mut shared, true);
        sample_control(&mut shared, at(base, 120));
        sample_control(&mut shared, at(base, 160));
        assert!(!shared.toggle.armed && !shared.snapshot.armed && !shared.toggle.released);
        assert_eq!(shared.snapshot.target.vx, 0.0);
    }

    #[test]
    fn driver_failure_clears_selection_and_preserves_original_error() {
        let base = Instant::now();
        let mut shared = selected_shared();
        arm(&mut shared.toggle, base);
        shared.fail_driver("WinMM 读取失败：access denied".into());
        assert!(!shared.snapshot.supported && !shared.toggle.armed);
        assert!(shared.snapshot.selected_key.is_empty() && shared.snapshot.pads.is_empty());
        assert!(shared.snapshot.error.contains("access denied"));
    }
}
