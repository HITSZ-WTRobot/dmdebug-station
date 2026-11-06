// 桌面通信的唯一写口。协议、轮询、遥控租约都由后台线程推进，事件只用于展示。
#[path = "wire.rs"]
mod wire;
#[path = "native_demo.rs"]
mod native_demo;
use wire::*;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct BodyVelocity { pub vx: f32, pub vy: f32, pub wz: f32 }
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct GamepadControlState { pub phase: String, pub message: String }
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NativeStatus {
    pub phase: String, pub port_open: bool, pub port_name: String, pub message: String,
    pub last_rx_at: u64, pub info_frame: Option<Vec<u8>>, pub tx_frames: u64,
    pub rx_frames: u64, pub crc_errors: u64, pub timeouts: u64, pub mode: String,
}
impl Default for NativeStatus {
    fn default() -> Self { Self { phase: "disconnected".into(), port_open: false, port_name: String::new(), message: "尚未连接；不会自动启动演示".into(), last_rx_at: 0, info_frame: None, tx_frames: 0, rx_frames: 0, crc_errors: 0, timeouts: 0, mode: "tauri".into() } }
}
struct Shared {
    ready: bool, gamepad: GamepadControlState, generation: u64,
    input: Option<(u64, BodyVelocity, Instant)>, manual: bool,
}
impl Default for Shared {
    fn default() -> Self { Self { ready: false, gamepad: GamepadControlState { phase: "off".into(), message: "手柄遥控未开启".into() }, generation: 0, input: None, manual: false } }
}
#[derive(Clone, Default)]
pub struct NativeState {
    sender: Arc<Mutex<Option<mpsc::Sender<Message>>>>,
    shared: Arc<Mutex<Shared>>,
}
type Reply = mpsc::Sender<Result<Vec<Vec<u8>>, String>>;
enum Message {
    Connect(String, String, Reply), Disconnect(Reply), Handshake(Reply), Select(u8, Reply),
    Refresh(Reply), Query(u8, Reply), Command(u8, u8, Vec<f32>, Reply),
    GamepadStart(u64), GamepadStop(u64, String),
}
impl NativeState {
    pub fn start(&self, app: AppHandle) {
        let mut slot = self.sender.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() { return; }
        let (tx, rx) = mpsc::channel(); let (events_tx, events_rx) = mpsc::channel();
        *slot = Some(tx);
        // emit 与串口调度隔离：UI 迟滞不会延长协议时钟。
        thread::spawn(move || {
            while let Ok(event) = events_rx.recv() {
                match event {
                    Event::Status(value) => { let _ = app.emit("native-status", value); }
                    Event::Response(value) => { let _ = app.emit("native-response", value); }
                    Event::Log(value) => { let _ = app.emit("native-log", value); }
                }
            }
        });
        let shared = self.shared.clone(); thread::spawn(move || actor(rx, events_tx, shared));
    }
    fn send(&self, message: Message) -> Result<(), String> {
        self.sender.lock().map_err(|_| "通信队列互斥锁异常")?.as_ref().ok_or("原生通信线程尚未启动")?.send(message).map_err(|_| "原生通信线程已退出".into())
    }
    pub fn gamepad_state(&self) -> GamepadControlState { self.shared.lock().unwrap_or_else(|e| e.into_inner()).gamepad.clone() }
    pub fn gamepad_start(&self) -> Result<(), String> {
        let generation = {
            let mut s = self.shared.lock().map_err(|_| "遥控状态锁异常")?;
            if !s.ready { return Err("未完成固件握手，禁止开启遥控".into()); }
            if s.gamepad.phase != "off" { return Err("手柄遥控尚未退出".into()); }
            if s.manual { return Err("上一条操作仍在等待应答".into()); }
            s.generation = s.generation.wrapping_add(1); s.input = None;
            s.gamepad = GamepadControlState { phase: "enabling".into(), message: "正在核对固件速度限制；仅请求底盘 0x40 使能".into() }; s.generation
        };
        if let Err(error) = self.send(Message::GamepadStart(generation)) {
            let mut s = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            if s.generation == generation { s.gamepad = GamepadControlState { phase: "off".into(), message: error.clone() }; }
            return Err(error);
        }
        Ok(())
    }
    pub fn gamepad_update(&self, target: BodyVelocity) -> Result<(), String> {
        if !valid_target(&target) { self.gamepad_stop("手柄输入超过平移 1 m/s 或旋转 10°/s 安全范围")?; return Err("无效的手柄速度；已请求退出遥控".into()); }
        let mut s = self.shared.lock().map_err(|_| "遥控状态锁异常")?;
        if matches!(s.gamepad.phase.as_str(), "enabling" | "active") { s.input = Some((s.generation, target, Instant::now())); }
        Ok(())
    }
    pub fn gamepad_stop(&self, reason: &str) -> Result<(), String> {
        let generation = {
            let mut s = self.shared.lock().map_err(|_| "遥控状态锁异常")?;
            s.input = None; s.generation = s.generation.wrapping_add(1);
            s.gamepad = GamepadControlState { phase: "stopping".into(), message: format!("{reason}；正在等待九设备失能应答，软件停机不保证物理停止") }; s.generation
        };
        if let Err(error) = self.send(Message::GamepadStop(generation, reason.into())) {
            let mut s = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            if s.generation == generation { s.gamepad = GamepadControlState { phase: "off".into(), message: format!("未确认全体失能：{error}") }; }
            return Err(error);
        }
        Ok(())
    }
    fn call(&self, make: impl FnOnce(Reply) -> Message) -> Result<Vec<Vec<u8>>, String> {
        let (tx, rx) = mpsc::channel(); self.send(make(tx))?; rx.recv().map_err(|_| "通信会话已关闭".to_string())?
    }
}
fn valid_target(v: &BodyVelocity) -> bool { v.vx.is_finite() && v.vy.is_finite() && v.wz.is_finite() && v.vx.hypot(v.vy) <= 1. && v.wz.abs() <= 10. }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Log { level: String, message: String, #[serde(skip_serializing_if = "Option::is_none")] raw_hex: Option<String> }
enum Event { Status(NativeStatus), Response(Vec<u8>), Log(Log) }
enum Effect { Write(Frame), Close, Open(String, String, Reply) }
#[derive(Clone, Copy, PartialEq)]
enum Tag { Handshake, Refresh, Query, Command, GamepadStart, Velocity, Stop, Poll }
struct Step { opcode: u8, id: u8, values: Vec<f32>, checked: bool }
fn step(opcode: u8, id: u8) -> Step { Step { opcode, id, values: Vec::new(), checked: true } }
enum After { None, Disconnect(Reply), Reconnect(String, String, Reply) }
struct Job {
    tag: Tag, steps: VecDeque<Step>, primary: Option<u8>, returned: Vec<Vec<u8>>,
    replies: Vec<Reply>, epoch: u64, generation: u64, after: After,
}
struct Transaction { job: Job, step: Step, bytes: Frame, expected: Vec<u8>, responses: Vec<Frame>, deadline: u64, retries: u8 }
struct Engine {
    status: NativeStatus, gamepad: GamepadControlState, generation: u64, epoch: u64,
    queue: VecDeque<Job>, active: Option<Transaction>, sequence: u16, parser: Stream,
    effects: VecDeque<Effect>, events: VecDeque<Event>, selected: u8, manual: bool,
    heartbeat_at: u64, state_at: u64, wheels_at: u64, now: u64, last_tick: u64,
    input: Option<(BodyVelocity, u64)>, input_at: u64, started_at: u64,
    velocity_at: Option<u64>, chassis_at: Option<u64>, chassis_ready: bool, enable_ack: bool,
    dirty: bool, last_publish: u64,
}
impl Engine {
    fn new() -> Self {
        Self { status: NativeStatus::default(), gamepad: GamepadControlState { phase: "off".into(), message: "手柄遥控未开启".into() }, generation: 0, epoch: 0, queue: VecDeque::new(), active: None, sequence: 1, parser: Stream::default(), effects: VecDeque::new(), events: VecDeque::new(), selected: 0x0a, manual: false, heartbeat_at: 0, state_at: 0, wheels_at: 0, now: 0, last_tick: 0, input: None, input_at: 0, started_at: 0, velocity_at: None, chassis_at: None, chassis_ready: false, enable_ack: false, dirty: true, last_publish: 0 }
    }
    fn log(&mut self, level: &str, message: impl Into<String>, bytes: Option<&Frame>) {
        let raw_hex = bytes.map(|b| {
            use std::fmt::Write as _;
            let mut text = String::with_capacity(191);
            for (i, byte) in b.iter().enumerate() { if i != 0 { text.push(' '); } let _ = write!(text,"{byte:02X}"); }
            text
        });
        self.events.push_back(Event::Log(Log { level: level.into(), message: message.into(), raw_hex }));
    }
    fn publish(&mut self) { self.dirty = false; self.last_publish = self.now; self.events.push_back(Event::Status(self.status.clone())); }
    fn phase(&mut self, phase: &str, message: impl Into<String>) { self.status.phase = phase.into(); self.status.message = message.into(); self.publish(); }
    fn gp(&mut self, phase: &str, message: impl Into<String>) { self.gamepad = GamepadControlState { phase: phase.into(), message: message.into() }; }
    fn job(&self, tag: Tag, steps: Vec<Step>, primary: Option<u8>, reply: Option<Reply>) -> Job {
        Job { tag, steps: steps.into(), primary, returned: Vec::new(), replies: reply.into_iter().collect(), epoch: self.epoch, generation: self.generation, after: After::None }
    }
    fn answer(job: &mut Job, value: Result<Vec<Vec<u8>>, String>) {
        let mut replies = std::mem::take(&mut job.replies).into_iter().peekable();
        while let Some(reply) = replies.next() {
            if replies.peek().is_none() { let _ = reply.send(value); break; }
            let _ = reply.send(value.clone());
        }
    }
    fn reject(job: &mut Job, message: &str) { Self::answer(job, Err(message.into()));
        let after = std::mem::replace(&mut job.after, After::None);
        match after { After::Disconnect(reply) | After::Reconnect(_, _, reply) => { let _ = reply.send(Err(message.into())); }, After::None => {} }
    }
    fn set_after(job: &mut Job, after: After) {
        match std::mem::replace(&mut job.after, after) {
            After::Disconnect(reply) | After::Reconnect(_, _, reply) => { let _ = reply.send(Err("连接操作已被更新的请求替换".into())); }
            After::None => {}
        }
    }
    fn cancel_queue(&mut self, reason: &str) {
        for mut job in self.queue.drain(..) { Self::reject(&mut job, reason); }
        self.manual = false;
    }
    fn invalidate(&mut self, reason: &str) {
        self.epoch = self.epoch.wrapping_add(1); self.input = None; self.enable_ack = false;
        self.chassis_at = None; self.chassis_ready = false; self.cancel_queue(reason);
    }
    fn cancel_effects(&mut self, reason: &str) {
        for effect in self.effects.drain(..) {
            if let Effect::Open(_, _, reply) = effect { let _ = reply.send(Err(reason.into())); }
        }
    }
    fn failure_message(&self, message: impl Into<String>) -> String {
        let message = message.into();
        if self.status.mode == "bluetooth" && self.status.port_open && self.status.phase == "handshaking" && !message.starts_with("蓝牙链路已建立") {
            format!("蓝牙链路已建立，但固件握手失败/无应答：{message}")
        } else { message }
    }
    fn fail(&mut self, message: impl Into<String>, phase: &str) {
        let message = self.failure_message(message); self.invalidate(&message);
        if let Some(mut active) = self.active.take() { Self::reject(&mut active.job, &message); }
        self.cancel_effects(&message); self.effects.push_back(Effect::Close); self.status.port_open = false;
        self.gp("off", format!("遥控已退出；{message}；未确认全体失能，软件停机不保证物理停止"));
        self.phase(phase, message.clone()); self.log("error", message, None);
    }
    fn close(&mut self) {
        self.cancel_effects("连接已关闭或被新连接替换");
        self.invalidate("连接已关闭");
        if let Some(mut tx) = self.active.take() { Self::reject(&mut tx.job, "连接已关闭"); }
        self.parser = Stream::default(); self.effects.push_back(Effect::Close); self.status.port_open = false; self.status.info_frame = None;
        self.gp("off", "连接已关闭；断开通讯不保证电机停止"); self.phase("disconnected", "已断开；断开通讯不等于实际电机已失能");
    }
    fn connect(&mut self, mode: String, port: String, reply: Reply) {
        if !matches!(mode.as_str(), "tauri" | "demo" | "bluetooth") { let _ = reply.send(Err("原生通信只接受 tauri、bluetooth 或明确的 demo 模式".into())); return; }
        if mode != "demo" && port.is_empty() { let _ = reply.send(Err(if mode == "bluetooth" { "请选择已配对的蓝牙SPP设备" } else { "请选择系统串口" }.into())); return; }
        if self.status.port_open && self.status.phase == "ready" {
            self.request_stop("切换连接，先等待全体失能", None);
            if let Some(job) = self.queue.iter_mut().find(|j| j.tag == Tag::Stop) { Self::set_after(job, After::Reconnect(mode, port, reply)); }
            else if let Some(tx) = self.active.as_mut().filter(|tx| tx.job.tag == Tag::Stop) { Self::set_after(&mut tx.job, After::Reconnect(mode, port, reply)); }
            else { let _ = reply.send(Err("切换连接前未能建立全体失能屏障".into())); }
            return;
        }
        self.close(); self.effects.push_back(Effect::Open(mode, port, reply));
    }
    fn opening(&mut self, mode: &str, port: &str) {
        self.status = NativeStatus { mode: mode.into(), port_name: if mode == "demo" { "协议演示 · 无硬件连接".into() } else { port.into() }, ..NativeStatus::default() };
        self.phase("opening", if mode == "bluetooth" { "正在建立蓝牙SPP链路，尚未完成固件握手" } else { "正在打开传输端口" });
    }
    fn opened(&mut self, mode: String, port: String, reply: Reply) {
        self.status = NativeStatus { mode: mode.clone(), port_name: if mode == "demo" { "协议演示 · 无硬件连接".into() } else { port }, port_open: true, ..NativeStatus::default() };
        self.last_tick = self.now; self.handshake(reply);
    }
    fn refresh_steps(&self) -> Vec<Step> {
        let mut steps = vec![step(STATE, 255), step(PARAMETERS, self.selected)];
        if self.selected == 0x40 { steps.push(step(WHEELS, 0x40)); } steps
    }
    fn handshake(&mut self, reply: Reply) {
        if !self.status.port_open { let _ = reply.send(Err("请先打开通信链路".into())); return; }
        // 重新握手不能丢弃已发出的速度/使能事务；先经过全体失能屏障。
        if matches!(self.gamepad.phase.as_str(), "active" | "enabling" | "stopping") {
            let _ = reply.send(Err("请先停止遥控并等待失能确认，再重新握手".into())); return;
        }
        self.invalidate("重新握手，旧事务已取消");
        self.parser = Stream::default(); self.status.info_frame = None;
        self.gp("off", "重新握手，手柄遥控已退出；需重新手动开启");
        self.phase("handshaking", if self.status.mode == "bluetooth" { "蓝牙SPP链路已建立，正在确认固件协议 v2 和九设备清单" } else { "端口已打开，正在确认协议 v2 和九设备清单" });
        let mut steps = vec![step(HEARTBEAT, 255), step(HEARTBEAT, 255), step(INFO, 255)]; steps.extend(self.refresh_steps());
        self.queue.push_back(self.job(Tag::Handshake, steps, None, Some(reply)));
    }
    fn ready(&self, reply: &Reply) -> bool {
        if self.status.phase == "ready" { true } else { let _ = reply.send(Err("未完成固件握手，禁止操作".into())); false }
    }
    fn refresh(&mut self, reply: Reply) {
        if self.ready(&reply) { self.queue.push_back(self.job(Tag::Refresh, self.refresh_steps(), None, Some(reply))); }
    }
    fn query(&mut self, id: u8, reply: Reply) {
        if !self.ready(&reply) { return; }
        if definition(id).is_none() { let _ = reply.send(Err("参数查询设备编号无效".into())); return; }
        let mut query = step(PARAMETERS, id); query.checked = false;
        self.queue.push_back(self.job(Tag::Query, vec![query], Some(PARAMETERS), Some(reply)));
    }
    fn command(&mut self, op: u8, id: u8, values: Vec<f32>, reply: Reply) {
        if !self.ready(&reply) { return; }
        if !matches!(op, ENABLE | DISABLE | STOP | ZERO | MOVE | LIMITS | VELOCITY | MOTOR_VELOCITY) { let _ = reply.send(Err("不支持的手动动作".into())); return; }
        let safe = matches!(op, DISABLE | STOP);
        if !safe && self.gamepad.phase != "off" { let _ = reply.send(Err("请先退出遥控，再执行普通手动操作".into())); return; }
        if self.manual && !safe { let _ = reply.send(Err("上一条操作仍在等待应答".into())); return; }
        if let Err(error) = request(0, op, id, &values) { let _ = reply.send(Err(error)); return; }
        if safe && self.gamepad.phase != "off" {
            // 手动安全意图先撤销全部遥控，不允许局部 Stop 保持另外的旧速度。
            self.request_stop("手动安全操作取消手柄遥控", if op == DISABLE && id == 255 { Some(reply.clone()) } else { None });
            if op == DISABLE && id == 255 { return; }
        } else if safe { self.invalidate("操作已被安全停机取消"); }
        self.manual = true;
        let mut steps = vec![Step { opcode: op, id, values, checked: false }];
        if matches!(op, LIMITS | ZERO) { steps.push(step(PARAMETERS, id)); } steps.push(step(STATE, id));
        let job = self.job(Tag::Command, steps, Some(op), Some(reply));
        if safe && self.gamepad.phase != "stopping" { self.queue.push_front(job); } else { self.queue.push_back(job); }
    }
    fn start_gamepad(&mut self, generation: u64) {
        self.generation = generation;
        if self.status.phase != "ready" || self.manual || self.gamepad.phase != "off" {
            self.gp("off", "通信或手动操作状态已变化；本次遥控启动已取消"); return;
        }
        self.input = None; self.input_at = self.now; self.started_at = self.now; self.velocity_at = None;
        self.chassis_at = None; self.chassis_ready = false; self.enable_ack = false;
        self.gp("enabling", "正在核对固件速度限制；仅请求底盘 0x40 使能");
        self.queue.push_back(self.job(Tag::GamepadStart, vec![step(PARAMETERS,0x40),step(ENABLE,0x40),step(STATE,0x40)], None, None));
    }
    fn request_stop(&mut self, reason: &str, reply: Option<Reply>) {
        self.input = None; self.enable_ack = false;
        if self.gamepad.phase == "stopping" {
            if let Some(job) = self.queue.iter_mut().find(|j| j.tag == Tag::Stop) {
                if reply.is_some() && !job.steps.iter().any(|s| s.opcode == STATE) { job.steps.push_back(step(STATE,255)); }
                job.replies.extend(reply); return;
            }
            if let Some(tx) = self.active.as_mut().filter(|t| t.job.tag == Tag::Stop) {
                if reply.is_some() && tx.step.opcode != STATE && !tx.job.steps.iter().any(|s| s.opcode == STATE) { tx.job.steps.push_back(step(STATE,255)); }
                tx.job.replies.extend(reply); return;
            }
        }
        self.invalidate("遥控已退出，排队操作已取消；操作已被安全停机取消");
        if !self.status.port_open || self.status.phase != "ready" {
            self.gp("off", format!("{reason}；未确认全体失能，当前无法发送；软件停机不保证物理停止"));
            if let Some(reply) = reply { let _ = reply.send(Err(self.gamepad.message.clone())); } return;
        }
        self.gp("stopping", format!("{reason}；正在等待九设备失能应答，软件停机不保证物理停止"));
        let mut disable = step(DISABLE,255); disable.checked = false;
        let mut steps = vec![disable]; if reply.is_some() { steps.push(step(STATE,255)); }
        self.queue.push_front(self.job(Tag::Stop, steps, Some(DISABLE), reply));
    }
    fn disconnect(&mut self, reply: Reply) {
        if self.status.port_open && self.status.phase == "ready" {
            self.request_stop("断开连接，先等待全体失能", None);
            if let Some(job) = self.queue.iter_mut().find(|j| j.tag == Tag::Stop) { Self::set_after(job, After::Disconnect(reply)); }
            else if let Some(tx) = self.active.as_mut().filter(|t| t.job.tag == Tag::Stop) { Self::set_after(&mut tx.job, After::Disconnect(reply)); }
            else { let _ = reply.send(Err("断开连接前未能建立全体失能屏障".into())); }
        } else { self.close(); let _ = reply.send(Ok(Vec::new())); }
    }
    fn pump(&mut self) {
        if self.active.is_some() || !self.status.port_open { return; }
        let Some(mut job) = self.queue.pop_front() else { return; };
        if job.epoch != self.epoch { Self::reject(&mut job,"操作已被安全停机取消"); return; }
        let Some(step) = job.steps.pop_front() else { return; };
        let bytes = match request(self.sequence, step.opcode, step.id, &step.values) { Ok(bytes) => bytes, Err(error) => { Self::reject(&mut job,&error); return; } };
        self.sequence = self.sequence.wrapping_add(1);
        let expected = expected(step.opcode,step.id); let retries = if matches!(step.opcode, VELOCITY | MOTOR_VELOCITY) { 0 } else { 1 };
        self.active = Some(Transaction { job, step, bytes, expected, responses: Vec::new(), deadline: self.now + 150, retries }); self.send_active();
    }
    fn send_active(&mut self) {
        let Some(tx) = self.active.as_mut() else { return; }; tx.deadline = self.now + 150; let bytes = tx.bytes;
        self.status.tx_frames += 1; self.dirty = true; self.log("tx",format!("#{} 命令 0x{:02X} · 0x{:02X}",u16_at(&bytes,4),bytes[6],bytes[7]),Some(&bytes)); self.effects.push_back(Effect::Write(bytes));
    }
    fn incoming(&mut self, bytes: &[u8]) {
        let (frames, issues) = self.parser.feed(bytes);
        for issue in issues { match issue {
            Issue::Crc => { self.status.crc_errors += 1; self.dirty = true; self.log("warn","CRC错误，逐字节重新同步",None); }
            Issue::Version => { self.fail("固件报文版本不匹配，本程序要求 v2","incompatible"); return; }
            Issue::Structure => self.log("warn","丢弃方向、长度、填充、设备映射或数值无效的应答",None),
        } }
        for frame in frames {
            self.status.rx_frames += 1; self.dirty = true;
            let Some(tx) = self.active.as_mut() else { continue; };
            if frame[4..7] != tx.bytes[4..7] { continue; }
            let result = u16_at(&frame,12);
            let terminal = result != 0 && frame[7] == tx.step.id && !(tx.step.opcode == DISABLE && tx.step.id == 255);
            if (!tx.expected.contains(&frame[7]) && !terminal) || tx.responses.iter().any(|b| b[7] == frame[7]) { continue; }
            tx.responses.push(frame);
            let complete = terminal || tx.expected.iter().all(|id| tx.responses.iter().any(|b| b[7] == *id));
            self.status.last_rx_at = unix_ms(); self.events.push_back(Event::Response(frame.to_vec()));
            self.log(if result == 0 { "rx" } else { "warn" },format!("#{} 命令 0x{:02X} · 0x{:02X} · 结果 {}",u16_at(&frame,4),frame[6],frame[7],result),Some(&frame));
            // 只有本会话匹配且首次收到的底盘状态可更新遥控门禁。
            if frame[6] == STATE && frame[7] == 0x40 { self.chassis(&frame); }
            else if frame[6] == STATE && result != 0 && frame[7] == 255 && matches!(self.gamepad.phase.as_str(),"active"|"enabling") { self.request_stop("底盘状态查询被拒绝",None); }
            if complete { self.complete(); }
        }
    }
    fn chassis(&mut self, b: &Frame) {
        let flags = u16_at(b,14); let result = u16_at(b,12);
        self.chassis_at = Some(self.now);
        self.chassis_ready = result == 0 && flags & (1|8) == (1|8) && flags & (16|128|256) == 0 && b[52] == 15 && b[53] == 15 && b[54] == 0;
        if !self.enable_ack { return; }
        if self.gamepad.phase == "enabling" && self.chassis_ready { self.gp("active","底盘四轮新反馈确认使能；摇杆回中只发送零速"); }
        else if (self.gamepad.phase == "active" && !self.chassis_ready) || (self.gamepad.phase == "enabling" && (result != 0 || flags & (128|256) != 0 || b[54] != 0)) { self.request_stop("底盘反馈异常，退出遥控",None); }
    }
    fn complete(&mut self) {
        let Some(mut tx) = self.active.take() else { return; };
        if tx.job.epoch != self.epoch || (tx.job.tag == Tag::GamepadStart && tx.job.generation != self.generation) { Self::reject(&mut tx.job,"操作已被安全停机取消"); return; }
        let op = tx.step.opcode;
        let failed = tx.responses.iter().find(|b| u16_at(*b,12) != 0);
        if tx.step.checked {
            if let Some(b) = failed {
                let result = u16_at(b,12);
                if !(tx.job.tag == Tag::Handshake && op == HEARTBEAT && result == 106) {
                    let error = self.failure_message(format!("命令 0x{op:02X} 被设备拒绝：结果 {result}"));
                    if tx.job.tag == Tag::GamepadStart {
                        if op == PARAMETERS { self.gp("off",error.clone()); } else { self.request_stop(&error,None); }
                        Self::reject(&mut tx.job,&error); return;
                    }
                    Self::reject(&mut tx.job,&error);
                    if matches!(tx.job.tag, Tag::Handshake | Tag::Poll | Tag::Stop) { self.fail(error,"unresponsive"); } else if tx.job.tag == Tag::Command { self.manual = false; }
                    return;
                }
            }
        }
        if tx.job.tag == Tag::Handshake && op == INFO {
            let b = &tx.responses[0];
            if u16_at(b,12) != 0 || u16_at(b,14) & 2 != 0 { let error = self.failure_message("设备发现锁存串口超时，需要新的心跳握手"); Self::reject(&mut tx.job,&error); self.fail(error,"unresponsive"); return; }
            self.status.info_frame = Some(b.to_vec()); self.publish();
        }
        if tx.job.tag == Tag::GamepadStart && op == PARAMETERS {
            let b = &tx.responses[0];
            if !(float(b,14) >= 1. && float(b,18) >= 1. && float(b,22) >= 10. && float(b,26) >= 160.) { self.input = None; self.gp("off","固件版本或速度限制不匹配：需要平移至少 1 m/s、旋转 10°/s、轮速至少 160 rpm；请更新固件"); return; }
        }
        if tx.job.tag == Tag::GamepadStart && op == ENABLE { self.enable_ack = true; self.started_at = self.now; self.gp("enabling","使能请求已应答，等待底盘四轮实际反馈确认"); }
        if tx.job.primary == Some(op) { tx.job.returned.extend(tx.responses.iter().map(|b| b.to_vec())); }
        if tx.job.tag == Tag::Velocity && failed.is_some() { self.request_stop("底盘拒绝速度指令",None); return; }
        if !tx.job.steps.is_empty() { self.queue.push_front(tx.job); return; }
        match tx.job.tag {
            Tag::Handshake => { self.heartbeat_at = self.now; self.state_at = self.now; self.wheels_at = self.now; self.last_tick = self.now; self.phase("ready",if self.status.mode == "demo" { "协议演示已就绪，不代表任何真实电机在线" } else { "固件握手成功，电机在线情况以各设备新反馈为准" }); }
            Tag::Command => { self.manual = false; }
            Tag::Stop => { let faults: Vec<String> = tx.job.returned.iter().filter(|b| u16_at(b,12) != 0).map(|b| format!("0x{:02X} 结果 {}",b[7],u16_at(b,12))).collect();
                self.gp("off",if faults.is_empty() { "已收齐九设备失能应答；软件停机不保证物理停止".into() } else { format!("已收齐九设备失能应答，存在故障：{}；软件停机不保证物理停止",faults.join("；")) });
            }
            _ => {}
        }
        let returned = std::mem::take(&mut tx.job.returned);
        Self::answer(&mut tx.job,Ok(returned));
        match tx.job.after { After::None => {}, After::Disconnect(reply) => { self.close(); let _ = reply.send(Ok(Vec::new())); }, After::Reconnect(mode,port,reply) => { self.close(); self.effects.push_back(Effect::Open(mode,port,reply)); } }
    }
    fn tick(&mut self, now: u64) {
        self.now = now;
        // 主机挂起超过固件 500ms 锁存边界后禁止恢复旧会话心跳/重试动作。
        if self.status.phase == "ready" && now.saturating_sub(self.last_tick) >= 500 { self.fail("后台通信时钟中断达到 500 ms，必须重新握手；不恢复旧动作","unresponsive"); self.last_tick = now; return; }
        self.last_tick = now;
        if matches!(self.gamepad.phase.as_str(),"active"|"enabling") {
            let reason = if now.saturating_sub(self.input_at) >= 250 { Some("手柄输入超过 250 ms 未刷新") }
                else if self.gamepad.phase == "active" && (self.chassis_at.map_or(true,|t| now.saturating_sub(t) >= 600) || !self.chassis_ready) { Some("底盘反馈过期或异常") }
                else if self.gamepad.phase == "enabling" && now.saturating_sub(self.started_at) >= 600 { Some("底盘未在 600 ms 内确认实际使能") } else { None };
            if let Some(reason) = reason { self.request_stop(reason,None); }
        }
        if self.active.as_ref().is_some_and(|tx| now >= tx.deadline) {
            self.status.timeouts += 1; self.dirty = true;
            let stale = self.active.as_ref().is_some_and(|tx| tx.job.epoch != self.epoch);
            if stale {
                let mut tx = self.active.take().unwrap(); Self::reject(&mut tx.job,"操作已被安全停机取消；不重发过期动作");
            } else if self.active.as_ref().unwrap().retries > 0 {
                self.active.as_mut().unwrap().retries -= 1; self.log("warn","150 ms 未收齐应答，原字节最多重发一次",None); self.send_active();
            } else { self.fail("请求无完整应答；未确认动作结果，已停止心跳并关闭通信","unresponsive"); return; }
        }
        if self.active.is_none() && self.queue.is_empty() && self.status.phase == "ready" && !self.manual && self.gamepad.phase != "stopping" {
            // 最早到期轮询优先于速度，不积累节拍，避免零速/满速流饿死心跳。
            let mut due = self.heartbeat_at + 100; let mut op = HEARTBEAT; let mut id = 255;
            if self.state_at + 200 < due { due = self.state_at + 200; op = STATE; }
            if self.selected == 0x40 && self.wheels_at + 400 < due { due = self.wheels_at + 400; op = WHEELS; id = 0x40; }
            if now >= due {
                match op { HEARTBEAT => self.heartbeat_at = now, STATE => self.state_at = now, _ => self.wheels_at = now }
                self.queue.push_back(self.job(Tag::Poll,vec![step(op,id)],None,None));
            } else if self.gamepad.phase == "active" && self.velocity_at.map_or(true,|t| now.saturating_sub(t) >= 100) {
                if let Some((target, at)) = self.input.as_ref() {
                    if now.saturating_sub(*at) < 250 && valid_target(target) {
                        let values = vec![target.vx,target.vy,target.wz]; self.velocity_at = Some(now);
                        self.queue.push_back(self.job(Tag::Velocity,vec![Step { opcode: VELOCITY,id:0x40,values,checked:false }],None,None));
                    }
                }
            }
        }
        self.pump(); if self.dirty && now.saturating_sub(self.last_publish) >= 100 { self.publish(); }
    }
}

// 所有已打开资源只归 actor 所有；临时 worker 只负责建立链路，不读写协议。
enum Io {
    Serial(Box<dyn serialport::SerialPort>), Bluetooth(crate::bluetooth::BluetoothStream), Demo(native_demo::Demo),
    #[cfg(test)] Test(tests::TestIo),
}
impl Io {
    fn read_available(&mut self, bytes: &mut [u8]) -> Option<std::io::Result<usize>> {
        match self {
            Self::Serial(port) => Some(port.read(bytes)),
            Self::Bluetooth(stream) => Some(stream.read_available(bytes)),
            Self::Demo(_) => None,
            #[cfg(test)] Self::Test(stream) => Some(stream.read_available(bytes)),
        }
    }
    fn eof_closes(&self) -> bool { !matches!(self, Self::Serial(_)) }
    fn write_frame(&mut self, bytes: &Frame) -> std::io::Result<()> {
        match self {
            Self::Serial(port) => port.write_all(bytes),
            Self::Bluetooth(stream) => stream.write_frame(bytes, Duration::from_millis(50)),
            Self::Demo(_) => unreachable!("演示回包由同一 Engine 处理"),
            #[cfg(test)] Self::Test(stream) => stream.write_frame(bytes, Duration::from_millis(50)),
        }
    }
}
fn open_timeout(mode: &str) -> Duration { Duration::from_secs(if mode == "bluetooth" { 8 } else { 2 }) }
fn open_transport(mode: String, port: String, cancelled: &AtomicBool, now: u64) -> Result<Io, String> {
    if cancelled.load(Ordering::Acquire) { return Err("打开通信链路已取消".into()); }
    let io = match mode.as_str() {
        "demo" => Io::Demo(native_demo::Demo::new(now)),
        "bluetooth" => Io::Bluetooth(crate::bluetooth::BluetoothStream::connect(&port, open_timeout(&mode), cancelled)?),
        _ => {
            let mut port = serialport::new(port,115200).data_bits(serialport::DataBits::Eight).stop_bits(serialport::StopBits::One).parity(serialport::Parity::None).flow_control(serialport::FlowControl::None).timeout(Duration::from_millis(5)).open().map_err(|error| format!("无法打开串口：{error}"))?;
            if cancelled.load(Ordering::Acquire) { return Err("打开串口已取消".into()); }
            let _ = port.write_data_terminal_ready(true); let _ = port.write_request_to_send(true);
            Io::Serial(port)
        }
    };
    if cancelled.load(Ordering::Acquire) { return Err("打开通信链路已取消".into()); }
    Ok(io)
}
struct PendingOpen {
    epoch: u64, mode: String, port: String, reply: Option<Reply>,
    cancelled: Arc<AtomicBool>, result: mpsc::Receiver<Result<Io, String>>, started: Instant,
}
impl PendingOpen {
    fn cancel(&mut self, reason: &str) {
        self.cancelled.store(true, Ordering::Release);
        if let Some(reply) = self.reply.take() { let _ = reply.send(Err(reason.into())); }
    }
}
impl Drop for PendingOpen {
    fn drop(&mut self) { self.cancel("连接已取消、被替换或通信线程已退出"); }
}
#[derive(Default)]
struct TransportOwner { io: Option<Io>, opening: Option<PendingOpen> }
impl TransportOwner {
    fn close(&mut self) { self.opening = None; self.io = None; }
    fn poll_open(&mut self, e: &mut Engine) {
        let Some(mut pending) = self.opening.take() else { return; };
        if pending.epoch != e.epoch {
            pending.cancel("打开连接已被安全退出或新连接取消");
            if e.status.phase == "opening" { e.close(); }
            return;
        }
        let result = if pending.started.elapsed() >= open_timeout(&pending.mode) {
            Some(Err(if pending.mode == "bluetooth" { "蓝牙SPP链路建立超时，请检查设备供电、配对及手机占用" } else { "打开端口超过 2 秒，请检查端口选择或占用" }.into()))
        } else { match pending.result.try_recv() {
            Ok(result) => Some(result),
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => Some(Err("打开通信链路的任务意外退出".into())),
        } };
        let Some(result) = result else { self.opening = Some(pending); return; };
        match result {
            Ok(io) => {
                self.io = Some(io);
                e.opened(std::mem::take(&mut pending.mode), std::mem::take(&mut pending.port), pending.reply.take().unwrap());
                e.pump();
            }
            Err(error) => {
                let error = if pending.mode == "bluetooth" { format!("蓝牙SPP链路建立失败：{error}") } else { error };
                pending.cancel(&error); e.fail(error, "disconnected");
            }
        }
    }
    fn effects<F>(&mut self, e: &mut Engine, opener: &Arc<F>)
    where F: Fn(String, String, &AtomicBool, u64) -> Result<Io, String> + Send + Sync + 'static {
        while let Some(effect) = e.effects.pop_front() {
            match effect {
                Effect::Close => self.close(),
                Effect::Open(mode, port, reply) => {
                    self.close(); e.opening(&mode, &port);
                    let cancelled = Arc::new(AtomicBool::new(false)); let worker_cancelled = cancelled.clone();
                    let (tx, result) = mpsc::channel(); let worker_mode = mode.clone(); let worker_port = port.clone();
                    let opener = opener.clone(); let now = e.now;
                    self.opening = Some(PendingOpen { epoch: e.epoch, mode, port, reply: Some(reply), cancelled, result, started: Instant::now() });
                    thread::spawn(move || {
                        let result = opener(worker_mode, worker_port, &worker_cancelled, now);
                        // 接收者已取消时，发送失败或直接丢弃会关闭迟到的真实句柄，绝不握手。
                        if !worker_cancelled.load(Ordering::Acquire) { let _ = tx.send(result); }
                    });
                }
                Effect::Write(bytes) => match self.io.as_mut() {
                    Some(Io::Demo(demo)) => { let replies = demo.handle(&bytes, e.now); for frame in replies { e.incoming(&frame); } e.pump(); }
                    Some(io) => { if let Err(error) = io.write_frame(&bytes) { e.fail(format!("通信帧发送失败：{error}"), "unresponsive"); } }
                    None => e.fail("通信链路尚未打开，无法发送；未确认全体失能", "unresponsive"),
                },
            }
        }
    }
    fn read(&mut self, e: &mut Engine) {
        let Some(io) = self.io.as_mut() else { return; };
        let eof_closes = io.eof_closes(); let mut bytes = [0u8; 512];
        let Some(result) = io.read_available(&mut bytes) else { return; };
        match result {
            Ok(0) if eof_closes => e.fail("通信链路已被对端关闭；未确认全体失能", "unresponsive"),
            Ok(n) if n > 0 => e.incoming(&bytes[..n]),
            Ok(_) => {},
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted) => {},
            Err(error) if !eof_closes && error.kind() == std::io::ErrorKind::TimedOut => {},
            Err(error) => e.fail(format!("通信链路读取失败：{error}"), "unresponsive"),
        }
        if !e.status.port_open { self.io = None; }
    }
}
fn unix_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn actor(rx: mpsc::Receiver<Message>, events: mpsc::Sender<Event>, shared: Arc<Mutex<Shared>>) {
    actor_with_opener(rx, events, shared, open_transport);
}
fn actor_with_opener<F>(rx: mpsc::Receiver<Message>, events: mpsc::Sender<Event>, shared: Arc<Mutex<Shared>>, opener: F)
where F: Fn(String, String, &AtomicBool, u64) -> Result<Io, String> + Send + Sync + 'static {
    let origin = Instant::now(); let mut e = Engine::new(); let mut owner = TransportOwner::default(); let mut alive = true;
    let opener = Arc::new(opener); let mut pending = None;
    while alive {
        let cycle = Instant::now(); e.now = origin.elapsed().as_millis() as u64;
        // 每轮先接收安全意图，再处理串口应答；旧应答不能复活已取消的启动链。
        loop { match pending.take().map(Ok).unwrap_or_else(||rx.try_recv()) {
            Ok(message) => match message {
                Message::Connect(mode,port,reply) => e.connect(mode,port,reply),
                Message::Disconnect(reply) => e.disconnect(reply), Message::Handshake(reply) => e.handshake(reply),
                Message::Select(id,reply) => { if definition(id).is_some() { e.selected=id; let _=reply.send(Ok(Vec::new())); } else { let _=reply.send(Err("设备编号无效".into())); } }
                Message::Refresh(reply) => e.refresh(reply), Message::Query(id,reply) => e.query(id,reply),
                Message::Command(op,id,values,reply) => e.command(op,id,values,reply),
                Message::GamepadStart(generation) => {
                    if shared.lock().unwrap_or_else(|p|p.into_inner()).generation == generation { e.start_gamepad(generation); }
                }
                Message::GamepadStop(generation,reason) => { e.generation=generation; e.request_stop(&reason,None); }
            },
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => { alive=false; break; }
        } }
        if !alive { break; }
        {
            let s=shared.lock().unwrap_or_else(|p|p.into_inner());
            if s.generation!=e.generation && s.gamepad.phase=="stopping" {
                e.generation=s.generation; e.request_stop("手柄安全退出意图",None);
            }
            if let Some((generation,target,at))=&s.input {
                if *generation==e.generation && matches!(e.gamepad.phase.as_str(),"active"|"enabling") {
                    let at=at.saturating_duration_since(origin).as_millis() as u64; e.input_at=at; e.input=Some((target.clone(),at));
                }
            }
        }
        // 安全邮箱和共享取消意图先于 worker 结果；epoch 不匹配的成功只会关闭资源。
        owner.poll_open(&mut e);
        e.tick(origin.elapsed().as_millis() as u64);
        owner.effects(&mut e, &opener);
        e.now = origin.elapsed().as_millis() as u64; owner.read(&mut e);
        owner.effects(&mut e, &opener);
        {
            let mut s=shared.lock().unwrap_or_else(|p|p.into_inner()); s.ready=e.status.phase=="ready"; s.manual=e.manual;
            // 同步调用已发布的新 start/stop 状态优先，避免 actor 的旧快照覆盖。
            if s.generation==e.generation {
                if s.gamepad.phase!=e.gamepad.phase || s.gamepad.message!=e.gamepad.message { s.gamepad=e.gamepad.clone(); }
                if e.gamepad.phase=="off" {s.input=None;}
            }
        }
        while let Some(event)=e.events.pop_front() { let _=events.send(event); }
        if owner.io.is_none() && e.effects.is_empty() && e.active.is_none() && e.queue.is_empty() {
            if owner.opening.is_some() {
                // worker 完成不会发送控制邮箱；opening 必须定时唤醒，且取消无需等连接超时。
                match rx.recv_timeout(Duration::from_millis(10)) {
                    Ok(message) => pending = Some(message),
                    Err(mpsc::RecvTimeoutError::Timeout) => {},
                    Err(mpsc::RecvTimeoutError::Disconnected) => alive = false,
                }
            } else {
                match rx.recv() { Ok(message) => pending = Some(message), Err(_) => alive = false }
            }
        } else {
            let elapsed=cycle.elapsed(); if elapsed<Duration::from_millis(10) {thread::sleep(Duration::from_millis(10)-elapsed);}
        }
    }
    // 队列所有者退出即取消 opening 并释放唯一链路；不维持运动心跳。
    e.close(); owner.close();
    let mut s = shared.lock().unwrap_or_else(|p|p.into_inner()); s.ready = false; s.manual = false;
    s.input = None; s.gamepad = e.gamepad;
}
async fn blocking(state: NativeState, make: impl FnOnce(Reply)->Message + Send + 'static) -> Result<Vec<Vec<u8>>,String> {
    tauri::async_runtime::spawn_blocking(move || state.call(make)).await.map_err(|e|format!("原生通信任务异常：{e}"))?
}
#[tauri::command]
pub async fn native_connect(state: State<'_,NativeState>,mode:String,port_name:String)->Result<(),String> { blocking(state.inner().clone(),move|reply|Message::Connect(mode,port_name,reply)).await.map(|_|()) }
#[tauri::command]
pub async fn native_disconnect(state: State<'_,NativeState>)->Result<(),String> { blocking(state.inner().clone(),Message::Disconnect).await.map(|_|()) }
#[tauri::command]
pub async fn native_handshake(state: State<'_,NativeState>)->Result<(),String> { blocking(state.inner().clone(),Message::Handshake).await.map(|_|()) }
#[tauri::command]
pub async fn native_select_device(state: State<'_,NativeState>,device_id:u8)->Result<(),String> { blocking(state.inner().clone(),move|reply|Message::Select(device_id,reply)).await.map(|_|()) }
#[tauri::command]
pub async fn native_refresh(state: State<'_,NativeState>)->Result<(),String> { blocking(state.inner().clone(),Message::Refresh).await.map(|_|()) }
#[tauri::command]
pub async fn native_query_parameters(state: State<'_,NativeState>,device_id:u8)->Result<Vec<Vec<u8>>,String> { blocking(state.inner().clone(),move|reply|Message::Query(device_id,reply)).await }
#[tauri::command]
pub async fn native_command(state: State<'_,NativeState>,opcode:u8,device_id:u8,values:Vec<f32>)->Result<Vec<Vec<u8>>,String> { blocking(state.inner().clone(),move|reply|Message::Command(opcode,device_id,values,reply)).await }

#[cfg(test)]
mod tests {
    use super::*;
    // 只验证 actor 的真实资源所有权；本地 TCP 不是蓝牙射频/固件测试。
    pub(super) struct TestIo {
        socket: std::net::TcpStream, writes: Arc<Mutex<Vec<Frame>>>,
        read_limit: usize, write_error: Option<std::io::ErrorKind>,
    }
    impl TestIo {
        pub(super) fn read_available(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            let n = bytes.len().min(self.read_limit); self.socket.read(&mut bytes[..n])
        }
        pub(super) fn write_frame(&mut self, bytes: &Frame, timeout: Duration) -> std::io::Result<()> {
            assert_eq!(timeout, Duration::from_millis(50));
            self.writes.lock().unwrap().push(*bytes);
            if let Some(kind) = self.write_error { self.socket.write_all(&bytes[..13])?; return Err(std::io::Error::new(kind, "消费者部分写入后超时")); }
            self.socket.write_all(bytes)
        }
    }
    fn socket_io(read_limit: usize, write_error: Option<std::io::ErrorKind>) -> (Io, std::net::TcpStream, Arc<Mutex<Vec<Frame>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let peer = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (socket, _) = listener.accept().unwrap(); socket.set_nonblocking(true).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let writes = Arc::new(Mutex::new(Vec::new()));
        (Io::Test(TestIo { socket, writes: writes.clone(), read_limit, write_error }), peer, writes)
    }
    fn closed_bytes(peer: &mut std::net::TcpStream) -> Vec<u8> {
        let mut bytes = Vec::new(); peer.read_to_end(&mut bytes).expect("唯一 owner 必须关闭真实 socket，不能只排队 Close"); bytes
    }
    fn never_open(_: String, _: String, _: &AtomicBool, _: u64) -> Result<Io, String> { panic!("本测试不应打开外部资源") }
    fn buffered_open(e: &mut Engine, result: Result<Io, String>) -> (TransportOwner, mpsc::Receiver<Result<Vec<Vec<u8>>, String>>, Arc<AtomicBool>) {
        let (reply, rx) = mpsc::channel(); let (tx, opened) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false)); e.opening("bluetooth", "AA:BB:CC:DD:EE:FF");
        assert!(tx.send(result).is_ok());
        (TransportOwner { io: None, opening: Some(PendingOpen {
            epoch: e.epoch, mode: "bluetooth".into(), port: "AA:BB:CC:DD:EE:FF".into(), reply: Some(reply),
            cancelled: cancelled.clone(), result: opened, started: Instant::now(),
        }) }, rx, cancelled)
    }
    fn await_phase(events: &mpsc::Receiver<Event>, phase: &str) -> NativeStatus {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match events.recv_timeout(deadline.saturating_duration_since(Instant::now())).expect("actor 未发布预期状态") {
                Event::Status(status) if status.phase == phase => return status,
                _ => {}
            }
        }
    }
    struct Harness { e: Engine, demo: native_demo::Demo, sent: Vec<(u64,Frame)> }
    impl Harness {
        fn ready() -> Self {
            let mut h=Self {e:Engine::new(),demo:native_demo::Demo::new(0),sent:Vec::new()};
            let (reply,rx)=mpsc::channel(); h.e.opened("demo".into(),String::new(),reply); h.e.pump(); h.drain();
            assert!(rx.try_recv().unwrap().is_ok()); assert_eq!(h.e.status.phase,"ready"); h
        }
        fn filtered(&mut self, mut filter: impl FnMut(&Frame,Vec<Frame>)->Vec<Frame>) {
            while let Some(effect)=self.e.effects.pop_front() {
                match effect {
                    Effect::Write(q)=>{self.sent.push((self.e.now,q));let frames=filter(&q,self.demo.handle(&q,self.e.now));for b in frames {self.e.incoming(&b);}self.e.pump();}
                    Effect::Close=>{}, Effect::Open(..)=>panic!("测试不应打开真实端口"),
                }
            }
        }
        fn drain(&mut self) {self.filtered(|_,replies|replies);}
        fn tick(&mut self,now:u64) {self.e.tick(now);self.drain();}
        fn arm(&mut self) {
            self.e.start_gamepad(1);self.input(BodyVelocity::default(),0);self.e.pump();self.drain();assert_eq!(self.e.gamepad.phase,"active");
        }
        fn input(&mut self,target:BodyVelocity,now:u64) {self.e.input_at=now;self.e.input=Some((target,now));}
        fn responses(&self)->usize {self.e.events.iter().filter(|v|matches!(v,Event::Response(_))).count()}
    }
    fn changed(mut b:Frame,change:impl FnOnce(&mut Frame))->Frame {change(&mut b);seal(&mut b);b}
    #[test]
    fn background_tick_drives_heartbeat_nine_states_and_four_wheels_without_ui() {
        let mut h=Harness::ready();h.e.selected=0x40;let start=h.sent.len();
        for now in (10..=2000).step_by(10) {h.tick(now);}
        assert_eq!(h.e.status.phase,"ready");assert_eq!(h.e.status.timeouts,0);
        for (op,gap,count) in [(HEARTBEAT,110,1),(STATE,220,9),(WHEELS,420,4)] {
            let sends:Vec<_>=h.sent[start..].iter().filter(|(_,b)|b[6]==op).collect();assert!(sends.len()>3);
            let mut previous=0;for (at,q) in sends {assert!(*at-previous<=gap);previous=*at;
                let matches=h.e.events.iter().filter(|event|match event {Event::Response(b)=>b[4..7]==q[4..7],_=>false}).count();assert_eq!(matches,count);
            }assert!(2000-previous<=gap);
        }
    }
    #[test]
    fn nine_distinct_matching_ids_required_and_retry_is_identical() {
        let mut h=Harness::ready();let (reply,rx)=mpsc::channel();h.e.refresh(reply);h.e.pump();let before=h.responses();
        h.filtered(|q,frames|if q[6]==STATE {frames[..8].to_vec()}else{frames});
        let q=h.e.active.as_ref().unwrap().bytes;let frames=h.demo.handle(&q,0);
        h.e.incoming(&frames[0]);let wrong=changed(frames[8],|b|put_u16(b,4,999));h.e.incoming(&wrong);
        assert!(rx.try_recv().is_err());assert_eq!(h.responses()-before,8);
        h.e.tick(149);assert!(h.e.effects.is_empty());h.e.tick(150);
        h.filtered(|q,frames|if q[6]==STATE {frames[..8].to_vec()}else{frames});
        assert_eq!(h.sent.last().unwrap().1,q);assert_eq!(h.responses()-before,8);
        h.e.incoming(&frames[8]);h.e.pump();h.drain();assert!(rx.try_recv().unwrap().is_ok());assert_eq!(h.responses()-before,10);
    }
    #[test]
    fn wheels_require_four_unique_responses_and_only_one_inflight() {
        let mut h=Harness::ready();h.e.selected=0x40;let (reply,rx)=mpsc::channel();h.e.refresh(reply);h.e.pump();
        h.filtered(|q,frames|if q[6]==WHEELS {frames[..3].to_vec()}else{frames});let held=h.e.active.as_ref().unwrap().bytes;
        let before=h.sent.len();h.e.tick(100);h.drain();assert_eq!(h.sent.len(),before);assert!(rx.try_recv().is_err());
        let frames=h.demo.handle(&held,100);h.e.incoming(&frames[0]);assert!(rx.try_recv().is_err());h.e.incoming(&frames[3]);assert!(rx.try_recv().unwrap().is_ok());
    }
    #[test]
    fn unmatched_info_does_not_make_ready_and_invalid_info_cannot_pass() {
        let mut e=Engine::new();let (reply,rx)=mpsc::channel();e.opened("demo".into(),String::new(),reply);e.pump();
        let mut demo=native_demo::Demo::new(0);let info=demo.handle(&request(90,INFO,255,&[]).unwrap(),0)[0];
        e.incoming(&info);assert_eq!(e.responses_for_test(),0);assert!(e.status.info_frame.is_none());assert_eq!(e.status.phase,"handshaking");
        let invalid=changed(info,|b|b[33]=4);e.incoming(&invalid);assert!(rx.try_recv().is_err());assert!(e.status.info_frame.is_none());
    }
    #[test]
    fn latest_velocity_single_slot_preserves_magnitude_and_neutral_does_not_disable() {
        let mut h=Harness::ready();h.arm();let (reply,rx)=mpsc::channel();h.e.query(0x0a,reply);h.e.pump();h.filtered(|_,_|Vec::new());let held=h.e.active.as_ref().unwrap().bytes;
        let start=h.sent.len();for i in 1..=7 {let now=i*40;h.input(BodyVelocity{vx:i as f32/20.,vy:0.,wz:-(i as f32)/2.},now);h.e.tick(now);h.filtered(|_,_|Vec::new());}
        assert!(h.sent[start..].iter().all(|(_,b)|b[6]!=VELOCITY));
        let frames=h.demo.handle(&held,280);for b in frames {h.e.incoming(&b);}assert!(rx.try_recv().unwrap().is_ok());h.tick(280);h.tick(290);h.tick(300);h.tick(310);
        let velocities:Vec<_>=h.sent[start..].iter().filter(|(_,b)|b[6]==VELOCITY).collect();assert_eq!(velocities.len(),1);let b=&velocities[0].1;assert_eq!([float(b,12),float(b,16),float(b,20)],[0.35,0.,-3.5]);
        for now in (320..=500).step_by(10) {h.input(BodyVelocity::default(),now);h.tick(now);}
        let velocities:Vec<_>=h.sent[start..].iter().filter(|(_,b)|b[6]==VELOCITY).collect();for pair in velocities.windows(2){assert!(pair[1].0-pair[0].0>=100);}assert_eq!(float(&velocities.last().unwrap().1,12),0.);
        assert_eq!(h.e.gamepad.phase,"active");assert!(h.sent[start..].iter().all(|(_,b)|b[6]!=DISABLE));
    }
    #[test]
    fn input_lease_stop_cancels_queue_and_never_retries_stale_enable() {
        let mut h=Harness::ready();h.e.start_gamepad(1);h.e.pump();h.filtered(|q,frames|if q[6]==ENABLE {Vec::new()}else{frames});let enable=h.e.active.as_ref().unwrap().bytes;
        let (reply,rx)=mpsc::channel();h.e.query(0x0a,reply);h.e.tick(250);
        assert_eq!(h.e.gamepad.phase,"stopping");assert!(rx.try_recv().unwrap().is_err());h.drain();
        assert_eq!(h.sent.iter().filter(|(_,b)|b[6]==ENABLE).count(),1);assert_eq!(h.sent.last().unwrap().1[6..8],[DISABLE,255]);assert_eq!(h.e.gamepad.phase,"off");
        let stale=h.demo.handle(&enable,251);for b in stale {h.e.incoming(&b);}h.tick(260);assert_eq!(h.e.gamepad.phase,"off");assert!(h.sent.iter().all(|(_,b)|b[6]!=VELOCITY));
    }
    #[test]
    fn stop_waits_current_transaction_and_nine_acks_including_faults() {
        let mut h=Harness::ready();h.arm();let (reply,rx)=mpsc::channel();h.e.query(0x0a,reply);h.e.pump();h.filtered(|_,_|Vec::new());let held=h.e.active.as_ref().unwrap().bytes;
        h.e.request_stop("测试停止",None);h.e.tick(10);assert_eq!(h.e.gamepad.phase,"stopping");assert!(h.e.effects.is_empty());
        for b in h.demo.handle(&held,10) {h.e.incoming(&b);}assert!(rx.try_recv().unwrap().is_err());h.e.pump();
        h.filtered(|q,frames|if q[6]==DISABLE {frames[..8].iter().enumerate().map(|(i,b)|if i==0 {changed(*b,|b|put_u16(b,12,107))}else{*b}).collect()}else{frames});
        let stop=h.e.active.as_ref().unwrap().bytes;assert_eq!(h.e.gamepad.phase,"stopping");h.e.tick(160);h.filtered(|_,_|Vec::new());assert_eq!(h.sent.last().unwrap().1,stop);
        let frames=h.demo.handle(&stop,160);h.e.incoming(&frames[8]);assert_eq!(h.e.gamepad.phase,"off");assert!(h.e.gamepad.message.contains("存在故障"));
    }
    #[test]
    fn velocity_is_never_retried_and_failure_stops_all_heartbeats() {
        let mut h=Harness::ready();h.arm();h.input(BodyVelocity{vx:0.5,vy:0.,wz:1.},0);h.e.tick(0);h.filtered(|_,_|Vec::new());
        h.input(BodyVelocity{vx:0.1,vy:0.,wz:0.},100);h.e.tick(150);h.drain();assert_eq!(h.e.status.phase,"unresponsive");assert!(!h.e.status.port_open);
        assert_eq!(h.sent.iter().filter(|(_,b)|b[6]==VELOCITY).count(),1);let end=h.sent.len();h.tick(1000);assert_eq!(h.sent.len(),end);assert!(h.e.gamepad.message.contains("未确认全体失能"));
    }
    #[test]
    fn stop_timeout_cannot_claim_physical_stop_or_maintain_link() {
        let mut h=Harness::ready();h.arm();h.e.request_stop("测试停止",None);h.e.pump();h.filtered(|_,_|Vec::new());
        h.e.tick(150);h.filtered(|_,_|Vec::new());h.e.tick(300);h.drain();assert_eq!(h.e.status.phase,"unresponsive");assert!(h.e.gamepad.message.contains("未确认全体失能"));
        let end=h.sent.len();h.tick(400);h.tick(500);assert_eq!(h.sent.len(),end);
    }
    #[test]
    fn exact_host_pause_boundary_prevents_cached_action_replay() {
        let mut h=Harness::ready();h.e.tick(499);assert_eq!(h.e.status.phase,"ready");
        let mut h=Harness::ready();h.arm();h.e.tick(500);h.drain();assert_eq!(h.e.status.phase,"unresponsive");assert!(h.e.status.message.contains("500"));
    }
    #[test]
    fn old_capability_rejected_and_enable_ack_without_feedback_not_active() {
        let mut h=Harness::ready();h.e.start_gamepad(1);h.e.pump();h.filtered(|q,frames|if q[6]==PARAMETERS {frames.into_iter().map(|b|changed(b,|b|put_float(b,26,30.))).collect()}else{frames});
        assert_eq!(h.e.gamepad.phase,"off");assert!(h.sent.iter().all(|(_,b)|b[6]!=ENABLE));
        h.e.start_gamepad(2);h.e.pump();h.filtered(|q,frames|if q[6]==STATE && q[7]==0x40 {frames.into_iter().map(|b|changed(b,|b|{put_u16(b,14,1|16);b[53]=0;})).collect()}else{frames});
        assert_eq!(h.e.gamepad.phase,"enabling");assert!(h.sent.iter().all(|(_,b)|b[6]!=VELOCITY));
        for now in (100..=600).step_by(100) {h.input(BodyVelocity::default(),now);h.e.tick(now);h.filtered(|q,frames|if q[6]==STATE {frames.into_iter().map(|b|if b[7]==0x40 {changed(b,|b|{put_u16(b,14,1|16);b[53]=0;})}else{b}).collect()}else{frames});}
        assert_eq!(h.e.gamepad.phase,"off");assert!(h.sent.iter().any(|(_,b)|b[6..8]==[DISABLE,255]));
    }
    #[test]
    fn state_freshness_and_new_fault_are_independent_safety_gates() {
        let mut h=Harness::ready();h.arm();h.e.chassis_at=Some(0);
        for now in (100..=500).step_by(100) {h.input(BodyVelocity::default(),now);h.e.now=now;h.e.last_tick=now;}
        h.input(BodyVelocity::default(),600);h.e.tick(600);h.drain();assert_eq!(h.e.gamepad.phase,"off");assert!(h.sent.iter().any(|(_,b)|b[6]==DISABLE));
        let mut h=Harness::ready();h.arm();let (reply,_rx)=mpsc::channel();h.e.refresh(reply);h.e.pump();h.filtered(|q,frames|if q[6]==STATE {frames.into_iter().map(|b|if b[7]==0x40 {changed(b,|b|{put_u16(b,14,1|8|128);b[54]=1;})}else{b}).collect()}else{frames});
        assert_eq!(h.e.gamepad.phase,"off");assert!(h.sent.iter().any(|(_,b)|b[6]==DISABLE));
    }
    #[test]
    fn manual_command_returns_only_action_and_runs_parameter_state_readback() {
        let mut h=Harness::ready();let start=h.sent.len();let (reply,rx)=mpsc::channel();h.e.command(LIMITS,0x0a,vec![2.,3.,4.],reply);h.e.pump();h.drain();
        let frames=rx.try_recv().unwrap().unwrap();assert_eq!(frames.len(),1);assert_eq!(frames[0][6],LIMITS);
        assert_eq!(h.sent[start..].iter().map(|(_,b)|b[6]).collect::<Vec<_>>(),vec![LIMITS,PARAMETERS,STATE]);
        let (reply,rx)=mpsc::channel();h.e.query(0x0a,reply);h.e.pump();h.filtered(|_,frames|frames.into_iter().map(|b|changed(b,|b|{put_u16(b,8,2);b[14..62].fill(0);put_u16(b,12,5);})).collect());
        let replies=rx.try_recv().unwrap().unwrap();assert_eq!(u16_at(&replies[0],12),5);
    }
    #[test]
    fn manual_safety_cancels_old_chain_and_cannot_revive_gamepad() {
        let mut h=Harness::ready();h.arm();let (reply,rx)=mpsc::channel();h.e.command(ENABLE,0x0a,vec![],reply);assert!(rx.try_recv().unwrap().is_err());
        let (reply,rx)=mpsc::channel();h.e.command(DISABLE,255,vec![],reply);h.e.pump();h.drain();assert_eq!(rx.try_recv().unwrap().unwrap().len(),9);assert_eq!(h.e.gamepad.phase,"off");
        let end=h.sent.len();h.input(BodyVelocity{vx:1.,vy:0.,wz:0.},100);h.tick(100);assert!(h.sent[end..].iter().all(|(_,b)|!matches!(b[6],ENABLE|VELOCITY)));
        let mut h=Harness::ready();let (reply,old)=mpsc::channel();h.e.command(ENABLE,0x0a,vec![],reply);h.e.pump();h.filtered(|_,_|Vec::new());let q=h.e.active.as_ref().unwrap().bytes;
        let (reply,safe)=mpsc::channel();h.e.command(DISABLE,255,vec![],reply);for b in h.demo.handle(&q,0){h.e.incoming(&b);}h.e.pump();h.drain();assert!(old.try_recv().unwrap().is_err());assert!(safe.try_recv().unwrap().is_ok());
    }
    #[test]
    fn explicit_stop_even_when_off_disables_all_and_disconnect_closes_resource() {
        let mut h=Harness::ready();h.e.request_stop("显式停止",None);h.e.pump();h.drain();assert_eq!(h.sent.last().unwrap().1[6..8],[DISABLE,255]);
        let (reply,rx)=mpsc::channel();h.e.disconnect(reply);h.e.pump();h.drain();assert!(rx.try_recv().unwrap().is_ok());assert!(!h.e.status.port_open);let end=h.sent.len();h.tick(100);assert_eq!(h.sent.len(),end);
    }
    #[test]
    fn motor_velocity_manual_command_is_supported_and_never_retried() {
        let mut h = Harness::ready();
        let (reply, enabled) = mpsc::channel(); h.e.command(ENABLE, 0x21, vec![], reply); h.e.pump(); h.drain();
        assert!(enabled.try_recv().unwrap().is_ok());
        let (reply, accepted) = mpsc::channel(); h.e.command(MOTOR_VELOCITY, 0x21, vec![-120.], reply); h.e.pump(); h.drain();
        let frames = accepted.try_recv().unwrap().unwrap(); assert_eq!(frames[0][6], MOTOR_VELOCITY); assert_eq!(u16_at(&frames[0], 12), 0);
        let start = h.sent.len();
        let (reply, pending) = mpsc::channel(); h.e.command(MOTOR_VELOCITY, 0x21, vec![80.], reply); h.e.pump(); h.filtered(|_, _| Vec::new());
        h.e.tick(150); h.drain(); assert!(pending.try_recv().unwrap().is_err());
        assert_eq!(h.sent[start..].iter().filter(|(_, frame)| frame[6] == MOTOR_VELOCITY).count(), 1);
        assert_eq!(h.e.status.phase, "unresponsive");
    }
    #[test]
    fn cancelled_buffered_open_drops_real_socket_without_old_handshake() {
        for safety_stop in [false, true] {
            let mut e = Engine::new(); let (io, mut peer, writes) = socket_io(512, None);
            let (mut owner, old, cancelled) = buffered_open(&mut e, Ok(io));
            if safety_stop { e.request_stop("连接中安全退出", None); }
            else { let (reply, disconnected) = mpsc::channel(); e.disconnect(reply); assert!(disconnected.try_recv().unwrap().is_ok()); }
            owner.poll_open(&mut e); owner.effects(&mut e, &Arc::new(never_open));
            assert!(old.try_recv().unwrap().is_err()); assert!(cancelled.load(Ordering::Acquire));
            assert!(owner.io.is_none()); assert!(owner.opening.is_none()); assert!(writes.lock().unwrap().is_empty());
            assert!(closed_bytes(&mut peer).is_empty()); assert_eq!(e.status.phase, "disconnected");
        }
    }
    #[test]
    fn actor_cancel_open_services_mailbox_and_discards_late_success() {
        let (io, mut peer, writes) = socket_io(512, None); let io = Mutex::new(Some(io));
        let (entered_tx, entered_rx) = mpsc::channel(); let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx); let (cancel_tx, cancel_rx) = mpsc::channel();
        let (tx, rx) = mpsc::channel(); let (events, event_rx) = mpsc::channel(); let shared = Arc::new(Mutex::new(Shared::default()));
        let thread = thread::spawn(move || actor_with_opener(rx, events, shared, move |_, _, cancelled, _| {
            entered_tx.send(()).unwrap(); release_rx.lock().unwrap().recv().unwrap();
            cancel_tx.send(cancelled.load(Ordering::Acquire)).unwrap(); Ok(io.lock().unwrap().take().unwrap())
        }));
        let (reply, connecting) = mpsc::channel(); assert!(tx.send(Message::Connect("bluetooth".into(), "AA:BB:CC:DD:EE:FF".into(), reply)).is_ok());
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let opening = await_phase(&event_rx, "opening"); assert_eq!(opening.mode, "bluetooth"); assert_eq!(opening.port_name, "AA:BB:CC:DD:EE:FF"); assert!(!opening.port_open);
        let (reply, disconnected) = mpsc::channel(); assert!(tx.send(Message::Disconnect(reply)).is_ok());
        assert!(disconnected.recv_timeout(Duration::from_secs(2)).unwrap().is_ok());
        assert!(connecting.recv_timeout(Duration::from_secs(2)).unwrap().is_err());
        release_tx.send(()).unwrap(); assert!(cancel_rx.recv_timeout(Duration::from_secs(2)).unwrap());
        assert!(closed_bytes(&mut peer).is_empty()); assert!(writes.lock().unwrap().is_empty());
        drop(tx); thread.join().unwrap();
    }
    #[test]
    fn rapid_switch_does_not_wait_for_old_worker_or_sleep_through_new_open() {
        let (io, mut peer, writes) = socket_io(512, None); let io = Mutex::new(Some(io));
        let (entered_tx, entered_rx) = mpsc::channel(); let (release_tx, release_rx) = mpsc::channel(); let release_rx = Mutex::new(release_rx);
        let (tx, rx) = mpsc::channel(); let (events, event_rx) = mpsc::channel(); let shared = Arc::new(Mutex::new(Shared::default()));
        let thread = thread::spawn(move || actor_with_opener(rx, events, shared, move |mode, _, _, now| {
            if mode == "demo" { return Ok(Io::Demo(native_demo::Demo::new(now))); }
            entered_tx.send(()).unwrap(); release_rx.lock().unwrap().recv().unwrap(); Ok(io.lock().unwrap().take().unwrap())
        }));
        let (reply, old) = mpsc::channel(); assert!(tx.send(Message::Connect("bluetooth".into(), "AA:BB:CC:DD:EE:FF".into(), reply)).is_ok());
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let (reply, current) = mpsc::channel(); assert!(tx.send(Message::Connect("demo".into(), String::new(), reply)).is_ok());
        assert!(old.recv_timeout(Duration::from_secs(2)).unwrap().is_err());
        // 不再投递 mailbox 消息：只靠 opening 的 recv_timeout 收获 worker 并握手。
        assert!(current.recv_timeout(Duration::from_secs(2)).unwrap().is_ok()); assert_eq!(await_phase(&event_rx, "ready").mode, "demo");
        release_tx.send(()).unwrap(); assert!(closed_bytes(&mut peer).is_empty()); assert!(writes.lock().unwrap().is_empty());
        drop(tx); thread.join().unwrap();
    }
    #[test]
    fn link_open_failure_keeps_bluetooth_endpoint_and_is_not_handshake_failure() {
        let mut e = Engine::new(); let (mut owner, reply, _) = buffered_open(&mut e, Err("WSA 10061，设备拒绝连接".into()));
        owner.poll_open(&mut e); owner.effects(&mut e, &Arc::new(never_open));
        let error = reply.try_recv().unwrap().unwrap_err(); assert!(error.contains("链路建立失败")); assert!(!error.contains("固件握手失败"));
        assert_eq!(e.status.mode, "bluetooth"); assert_eq!(e.status.port_name, "AA:BB:CC:DD:EE:FF"); assert!(!e.status.port_open);
    }
    #[test]
    fn bluetooth_handshake_timeout_closes_owner_and_reports_firmware_stage() {
        let mut e = Engine::new(); let (io, mut peer, writes) = socket_io(512, None); let (mut owner, reply, _) = buffered_open(&mut e, Ok(io));
        owner.poll_open(&mut e); owner.effects(&mut e, &Arc::new(never_open));
        assert_eq!(e.status.phase, "handshaking"); assert!(e.status.port_open);
        e.tick(150); owner.effects(&mut e, &Arc::new(never_open)); e.tick(300); owner.effects(&mut e, &Arc::new(never_open));
        assert!(reply.try_recv().unwrap().unwrap_err().contains("蓝牙链路已建立，但固件握手失败/无应答"));
        assert!(owner.io.is_none()); assert_eq!(closed_bytes(&mut peer).len(), 128); assert_eq!(writes.lock().unwrap().len(), 2);
        e.tick(1000); owner.effects(&mut e, &Arc::new(never_open)); assert_eq!(writes.lock().unwrap().len(), 2);
    }
    #[test]
    fn bluetooth_would_block_and_fragmented_reads_use_existing_parser() {
        let mut h = Harness::ready(); h.e.status.mode = "bluetooth".into();
        let (io, mut peer, writes) = socket_io(3, None); let mut owner = TransportOwner { io: Some(io), opening: None };
        owner.read(&mut h.e); assert_eq!(h.e.status.phase, "ready"); assert!(owner.io.is_some());
        let (reply, response) = mpsc::channel(); h.e.query(0x0a, reply); h.e.pump(); let q = h.e.active.as_ref().unwrap().bytes;
        owner.effects(&mut h.e, &Arc::new(never_open)); let b = h.demo.handle(&q, 0)[0]; peer.write_all(&b).unwrap();
        for _ in 0..21 { owner.read(&mut h.e); assert!(matches!(response.try_recv(), Err(mpsc::TryRecvError::Empty))); }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            owner.read(&mut h.e);
            match response.try_recv() {
                Ok(result) => { assert_eq!(result.unwrap(), vec![b.to_vec()]); break; }
                Err(mpsc::TryRecvError::Empty) => { assert!(Instant::now() < deadline); thread::yield_now(); }
                Err(error) => panic!("{error}"),
            }
        }
        assert_eq!(h.e.status.phase, "ready"); assert_eq!(writes.lock().unwrap().len(), 1);
    }
    #[test]
    fn bluetooth_eof_revokes_old_speed_and_closes_actual_owner() {
        let mut h = Harness::ready(); h.arm(); h.e.status.mode = "bluetooth".into(); h.input(BodyVelocity { vx: 0.8, vy: 0., wz: 0. }, 0);
        let (io, mut peer, writes) = socket_io(512, None); let mut owner = TransportOwner { io: Some(io), opening: None };
        peer.shutdown(std::net::Shutdown::Write).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while owner.io.is_some() { owner.read(&mut h.e); assert!(Instant::now() < deadline); thread::yield_now(); }
        owner.effects(&mut h.e, &Arc::new(never_open)); assert!(h.e.input.is_none()); assert_eq!(h.e.gamepad.phase, "off");
        assert!(h.e.gamepad.message.contains("未确认全体失能")); assert!(closed_bytes(&mut peer).is_empty());
        h.e.tick(1000); owner.effects(&mut h.e, &Arc::new(never_open)); assert!(writes.lock().unwrap().is_empty());
        let (reply, new_session) = mpsc::channel(); h.e.opened("demo".into(), String::new(), reply); h.e.pump(); h.drain(); assert!(new_session.try_recv().unwrap().is_ok());
        let start = h.sent.len(); h.tick(1100); assert!(h.sent[start..].iter().all(|(_, b)| !matches!(b[6], VELOCITY | ENABLE))); assert_eq!(h.e.gamepad.phase, "off");
    }
    #[test]
    fn bluetooth_write_timeout_closes_owner_without_retransmitting_frame() {
        let mut h = Harness::ready(); h.arm(); h.e.status.mode = "bluetooth".into(); h.input(BodyVelocity { vx: 0.5, vy: 0., wz: 0. }, 0);
        let (io, mut peer, writes) = socket_io(512, Some(std::io::ErrorKind::TimedOut)); let mut owner = TransportOwner { io: Some(io), opening: None };
        h.e.tick(0); owner.effects(&mut h.e, &Arc::new(never_open));
        assert!(owner.io.is_none()); assert_eq!(closed_bytes(&mut peer).len(), 13); assert!(h.e.input.is_none()); assert_eq!(h.e.gamepad.phase, "off");
        h.e.tick(150); h.e.tick(1000); owner.effects(&mut h.e, &Arc::new(never_open));
        let writes = writes.lock().unwrap(); assert_eq!(writes.len(), 1); assert_eq!(writes[0][6], VELOCITY);
    }
    #[test]
    fn switch_waits_for_nine_disable_acks_before_closing_real_owner() {
        let mut h = Harness::ready(); h.arm(); h.e.status.mode = "bluetooth".into();
        let (io, mut peer, writes) = socket_io(512, None); let mut owner = TransportOwner { io: Some(io), opening: None };
        let (reply, switching) = mpsc::channel(); h.e.connect("demo".into(), String::new(), reply); h.e.pump();
        let disable = h.e.active.as_ref().unwrap().bytes; assert_eq!(disable[6..8], [DISABLE, 255]);
        owner.effects(&mut h.e, &Arc::new(never_open)); assert!(owner.io.is_some()); assert!(switching.try_recv().is_err());
        let frames = h.demo.handle(&disable, 0); for b in &frames[..8] { h.e.incoming(b); }
        owner.effects(&mut h.e, &Arc::new(never_open)); assert!(owner.io.is_some()); assert!(owner.opening.is_none());
        h.e.incoming(&frames[8]);
        owner.effects(&mut h.e, &Arc::new(open_transport));
        assert!(owner.io.is_none()); assert!(owner.opening.is_some());
        assert_eq!(closed_bytes(&mut peer).len(), 64); assert_eq!(writes.lock().unwrap().len(), 1);
        assert_eq!(h.e.status.mode, "demo"); assert_eq!(h.e.status.phase, "opening");
        h.e.close(); owner.close(); assert!(switching.try_recv().unwrap().is_err());
    }
    #[test]
    fn superseded_switch_replies_all_complete_without_bypassing_stop_barrier() {
        let mut h = Harness::ready(); h.arm();
        let (reply, first) = mpsc::channel(); h.e.connect("bluetooth".into(), "AA:BB:CC:DD:EE:FF".into(), reply); h.e.pump(); h.filtered(|_, _| Vec::new());
        let (reply, second) = mpsc::channel(); h.e.connect("tauri".into(), "COM9".into(), reply); assert!(first.try_recv().unwrap().is_err());
        let (reply, disconnected) = mpsc::channel(); h.e.disconnect(reply); assert!(second.try_recv().unwrap().is_err());
        let q = h.e.active.as_ref().unwrap().bytes; for b in h.demo.handle(&q, 0) { h.e.incoming(&b); }
        h.drain(); assert!(disconnected.try_recv().unwrap().is_ok()); assert!(!h.e.status.port_open);
    }
    #[test]
    fn serial_and_bluetooth_late_open_after_deadline_never_handshake() {
        for mode in ["tauri", "bluetooth"] {
            let mut e = Engine::new(); let (io, mut peer, writes) = socket_io(512, None);
            let (mut owner, reply, cancelled) = buffered_open(&mut e, Ok(io));
            let pending = owner.opening.as_mut().unwrap(); pending.mode = mode.into();
            pending.port = if mode == "tauri" { "COM9" } else { "AA:BB:CC:DD:EE:FF" }.into();
            pending.started = Instant::now() - open_timeout(mode); e.opening(mode, &pending.port);
            owner.poll_open(&mut e); owner.effects(&mut e, &Arc::new(never_open));
            assert!(reply.try_recv().unwrap().unwrap_err().contains(if mode == "tauri" { "2 秒" } else { "超时" }));
            assert_eq!(e.status.mode, mode); assert!(cancelled.load(Ordering::Acquire));
            assert!(writes.lock().unwrap().is_empty()); assert!(closed_bytes(&mut peer).is_empty()); assert!(owner.io.is_none());
        }
    }
    #[test]
    fn owner_exit_completes_pending_reply_and_drops_buffered_resource() {
        let mut e = Engine::new(); let (io, mut peer, writes) = socket_io(512, None);
        let (owner, reply, cancelled) = buffered_open(&mut e, Ok(io)); drop(owner);
        assert!(reply.try_recv().unwrap().is_err()); assert!(cancelled.load(Ordering::Acquire));
        assert!(closed_bytes(&mut peer).is_empty()); assert!(writes.lock().unwrap().is_empty());
    }
    impl Engine {fn responses_for_test(&self)->usize {self.events.iter().filter(|e|matches!(e,Event::Response(_))).count()}}
}
