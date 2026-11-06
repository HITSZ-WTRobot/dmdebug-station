use super::*;
use std::collections::HashSet;

// 真实Engine和协议模型，延迟仅在字节传输边界注入，不连接无线设备。
struct DelayedLink {
    engine: Engine,
    device: native_demo::Demo,
    received: VecDeque<(u64, Frame)>,
    sent: Vec<(u64, Frame)>,
}
impl DelayedLink {
    fn new() -> (Self, mpsc::Receiver<Result<Vec<Vec<u8>>, String>>) {
        let mut engine = Engine::new();
        let (reply, result) = mpsc::channel();
        engine.opened("bluetooth".into(), "98:D3:02:96:A7:61".into(), reply);
        engine.pump();
        (Self { engine, device: native_demo::Demo::new(0), received: VecDeque::new(), sent: Vec::new() }, result)
    }
    fn cycle(&mut self, now: u64, delay: impl Fn(u8) -> u64) {
        self.engine.now = now;
        while self.received.front().is_some_and(|(due, _)| *due <= now) {
            let (_, frame) = self.received.pop_front().unwrap();
            self.engine.incoming(&frame);
        }
        self.engine.tick(now);
        while let Some(effect) = self.engine.effects.pop_front() {
            match effect {
                Effect::Write(request) => {
                    self.sent.push((now, request));
                    let frames = self.device.handle(&request, now);
                    let first = now + delay(request[6]);
                    for (index, frame) in frames.into_iter().enumerate() {
                        // 多帧应答分批传回，与用户日志中的状态广播一致。
                        self.received.push_back((first + index as u64 * 8, frame));
                    }
                }
                Effect::Close => self.received.clear(),
                Effect::Open(..) => panic!("延迟字节边界不应建立真实连接"),
            }
        }
    }
    fn handshake(&mut self) -> u64 {
        for now in (0..5000).step_by(10) {
            // 握手完成时暂缓周期轮询，让调用者从空闲边界提交被测事务。
            self.engine.manual = true;
            self.cycle(now, |_| 120);
            if self.engine.status.phase == "ready" { self.engine.manual = false; return now; }
            assert_ne!(self.engine.status.phase, "unresponsive");
        }
        panic!("延迟握手未完成");
    }
}

#[test]
fn delayed_heartbeats_and_fragmented_broadcast_complete_without_duplicate_requests() {
    let (mut link, ready) = DelayedLink::new();
    for now in (0..8000).step_by(10) {
        link.cycle(now, |op| if op == STATE { 180 } else if op == HEARTBEAT { 340 } else { 180 });
    }
    assert!(ready.try_recv().unwrap().is_ok());
    assert_eq!(link.engine.status.phase, "ready");
    assert_eq!(link.engine.status.timeouts, 0);
    assert!(!link.device.handle(&request(65000, STATE, 0x21, &[]).unwrap(), 8000).iter()
        .any(|frame| u16_at(frame, 14) & 256 != 0));
    let mut sequences = HashSet::new();
    for (_, frame) in &link.sent { assert!(sequences.insert(u16_at(frame, 4)), "不得重发迟到广播/心跳"); }
    assert!(link.sent.windows(2).all(|pair| pair[1].0 - pair[0].0 < 500));
    assert!(link.sent.iter().filter(|(_, frame)| frame[6] == STATE).count() >= 4);
}

#[test]
fn missing_last_device_fails_at_deadline_without_retry_or_late_revival() {
    let (mut link, ready) = DelayedLink::new();
    let now = link.handshake(); assert!(ready.try_recv().unwrap().is_ok());
    let (reply, result) = mpsc::channel(); link.engine.refresh(reply); link.engine.pump();
    let bytes = link.engine.active.as_ref().unwrap().bytes;
    let frames = link.device.handle(&bytes, now);
    link.engine.effects.clear();
    for frame in &frames[..8] { link.engine.incoming(frame); }
    link.engine.tick(now + 399);
    assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
    assert!(link.engine.effects.is_empty());
    link.engine.tick(now + 400);
    assert!(result.try_recv().unwrap().is_err());
    assert_eq!(link.engine.status.phase, "unresponsive");
    assert!(!link.engine.status.port_open);
    // 缺失设备诊断应指出0x40，而不是把部分回包称作完全无应答。
    assert!(link.engine.status.message.contains("0x40"));
    assert!(link.engine.input.is_none());
    link.engine.effects.clear(); link.engine.incoming(&frames[8]); link.engine.tick(now + 450);
    assert_ne!(link.engine.status.phase, "ready"); assert!(link.engine.effects.is_empty());
}

#[test]
fn remote_velocity_and_status_share_slow_link_without_redundant_heartbeat_starvation() {
    let (mut link, ready) = DelayedLink::new();
    let start = link.handshake(); assert!(ready.try_recv().unwrap().is_ok());
    link.engine.selected = 0x40;
    link.engine.start_gamepad(1);
    for now in ((start + 10)..(start + 5000)).step_by(10) {
        link.engine.input_at = now;
        link.engine.input = Some((BodyVelocity { vx: 0.2, vy: 0., wz: 1. }, now));
        link.cycle(now, |_| 120);
        assert_ne!(link.engine.status.phase, "unresponsive");
    }
    assert_eq!(link.engine.gamepad.phase, "active");
    let active: Vec<_> = link.sent.iter().filter(|(at, _)| *at > start + 700).collect();
    assert!(active.iter().filter(|(_, frame)| frame[6] == VELOCITY).count() >= 5);
    assert!(active.iter().filter(|(_, frame)| frame[6] == STATE).count() >= 5);
    assert!(active.iter().all(|(_, frame)| frame[6] != WHEELS));
    assert!(active.windows(2).all(|pair| pair[1].0 - pair[0].0 < 500));
    assert_eq!(link.engine.status.timeouts, 0);
}

#[test]
fn slow_bluetooth_does_not_extend_input_or_feedback_safety_leases() {
    let (mut link, ready) = DelayedLink::new();
    let now = link.handshake(); assert!(ready.try_recv().unwrap().is_ok());
    link.engine.gamepad.phase = "active".into(); link.engine.input_at = now;
    link.engine.chassis_at = Some(now); link.engine.chassis_ready = true;
    link.engine.input = Some((BodyVelocity { vx: 0.2, vy: 0., wz: 0. }, now));
    link.engine.tick(now + 250);
    assert_eq!(link.engine.gamepad.phase, "stopping"); assert!(link.engine.input.is_none());
    let (mut link, ready) = DelayedLink::new();
    let now = link.handshake(); assert!(ready.try_recv().unwrap().is_ok());
    link.engine.gamepad.phase = "active".into(); link.engine.chassis_at = Some(now); link.engine.chassis_ready = true;
    link.engine.now = now + 590; link.engine.last_tick = now + 590; link.engine.input_at = now + 600;
    link.engine.tick(now + 600);
    assert_eq!(link.engine.gamepad.phase, "stopping"); assert!(link.engine.input.is_none());
}
