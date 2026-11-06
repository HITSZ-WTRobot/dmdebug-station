// 明确选择的本地协议模型，不连接硬件，也不声称模拟真实电机物理。
use super::wire::*;
#[derive(Clone)]
struct Device {
    id: u8, kind: u8, position: f32, target: f32, origin: f32,
    enabled: bool, busy: bool, complete: bool, fault: bool, result: u16,
    count: u32, stationary_count: u32, body: [f32; 3], limits: [f32; 5],
}
pub struct Demo {
    devices: [Device; 9], previous: u64, last_request: u64, timeout: bool,
    cached: Option<Frame>, replies: Vec<Frame>,
}
fn response(q: &Frame, id: u8, result: u16, length: u16) -> Frame {
    let mut b = [0; 64]; b[..4].copy_from_slice(&[0xa5, 0x5a, 2, 1]); b[4..7].copy_from_slice(&q[4..7]); b[7] = id;
    put_u16(&mut b, 8, length); put_u16(&mut b, 12, result); b
}
impl Demo {
    pub fn new(now: u64) -> Self {
        Self { devices: std::array::from_fn(|i| Device { id: IDS[i], kind: KINDS[i], position: 0., target: 0., origin: 0., enabled: false, busy: false, complete: false, fault: false, result: 0, count: 50, stationary_count: 50, body: [0.; 3], limits: if KINDS[i] == 1 { [6.283333, 12.566667, 62.833333, 0., 0.] } else { [-180., 180., 10., 20., 100.] } }), previous: now, last_request: now, timeout: false, cached: None, replies: Vec::new() }
    }
    pub fn handle(&mut self, q: &Frame, now: u64) -> Vec<Frame> {
        let dt = (now.saturating_sub(self.previous) as f32 / 1000.).min(1.); self.previous = now;
        let timed_out = now.saturating_sub(self.last_request) >= 500;
        if timed_out {
            self.timeout = true;
            for m in &mut self.devices { m.enabled = false; m.busy = false; m.fault = true; m.result = 107; m.body = [0.; 3]; if m.kind == 5 { m.target = 0.; m.stationary_count = 0; } }
        }
        for m in &mut self.devices {
            m.count = m.count.wrapping_add((dt * 500.).round().max(1.) as u32);
            if m.kind == 5 {
                let rpm = if m.enabled { m.target } else { 0. };
                m.position += rpm * 6. * dt;
                if !timed_out { m.stationary_count = if rpm.abs() <= 0.1 { (m.stationary_count + (dt * 500.).round() as u32).min(50) } else { 0 }; }
            } else if m.busy {
                let speed = if m.kind == 1 { m.limits[0] } else { m.limits[2] };
                let distance = m.target - m.position; m.position += distance.signum() * distance.abs().min(dt * speed);
                if (m.position - m.target).abs() < 0.0001 { m.position = m.target; m.busy = false; m.complete = true; }
            }
        }
        if let Some(cached) = self.cached.as_ref() {
            if q[4..6] == cached[4..6] {
                if q != cached { let mut b = response(q, q[7], 106, 2); seal(&mut b); return vec![b]; }
                if !self.timeout { self.last_request = now; }
                return self.replies.clone();
            }
        }
        let op = q[6]; let id = q[7]; let mut result = Vec::new();
        let n = u16_at(q, 8) as usize;
        let request_error = if q[..2] != [0xa5, 0x5a] || u16_at(q, 62) != crc(&q[..62]) { 102 }
            else if q[2] != 2 { 100 } else if q[3] != 0 { 101 }
            else if n > 48 || n % 4 != 0 { 102 }
            else if u16_at(q, 10) != 0 || q[12 + n..62].iter().any(|v| *v != 0) { 103 } else { 0 };
        if request_error != 0 { result.push(response(q, id, request_error, 2)); }
        else if matches!(op, HEARTBEAT | INFO) && id == 255 && n == 0 {
            if op == HEARTBEAT { self.timeout = false; }
            if !self.timeout { self.last_request = now; }
            let mut b = response(q, 255, 0, if op == INFO { 42 } else { 8 });
            put_u16(&mut b, 14, 1 | if self.timeout { 2 } else { 0 }); put_u32(&mut b, 16, now as u32);
            if op == INFO { put_u16(&mut b, 20, 500); b[22] = 9; b[23] = 2; b[24..33].copy_from_slice(&IDS); b[33..42].copy_from_slice(&KINDS);
                for (i, value) in [100, 500, 1000, 500].iter().enumerate() { put_u16(&mut b, 42 + i * 2, *value); } put_u32(&mut b, 50, 115200); }
            result.push(b);
        } else if op == WHEELS && id == 0x40 && n == 0 {
            if !self.timeout { self.last_request = now; }
            let m = &self.devices[8]; let [vx, vy, wz] = m.body;
            for (i, tangent) in [vx + vy, -vx + vy, -vx - vy, vx - vy].iter().enumerate() {
                let mut b = response(q, 0x41 + i as u8, 0, 20); put_u16(&mut b, 14, 1); let can = [0x0b, 0x0a, 0x09, 0x0c][i]; b[16] = can; b[17] = 0x20 + can; put_u16(&mut b, 18, u16::from(m.enabled));
                let rpm = if m.enabled { (tangent / std::f32::consts::SQRT_2 + 0.2175f32.hypot(0.2175) * wz.to_radians()) / 0.0635 * 60. / std::f32::consts::TAU } else { 0. };
                put_float(&mut b, 24, rpm); result.push(b);
            }
        } else {
            if !self.timeout { self.last_request = now; }
            if id == 255 && !matches!(op, STATE | DISABLE | STOP) { result.push(response(q, id, 105, 2)); }
            else if id != 255 && !IDS.contains(&id) { result.push(response(q, id, 105, 2)); }
            else {
                for m in &mut self.devices {
                    if id != 255 && m.id != id { continue; }
                    if op == STATE && n == 0 { result.push(Self::state(q, m, self.timeout)); continue; }
                    if op == PARAMETERS && n == 0 { result.push(Self::parameters(q, m)); continue; }
                    let required = match op { MOVE | MOTOR_VELOCITY => 4, VELOCITY => 12, LIMITS => if m.kind == 1 { 12 } else { 20 }, _ => 0 };
                    let mut code = 0;
                    if (m.kind == 5 && matches!(op, MOVE | ZERO | LIMITS)) || (op == MOTOR_VELOCITY && m.kind != 5) { code = 105; }
                    else if n != required { code = 102; }
                    else if self.timeout && matches!(op, ENABLE | MOVE | VELOCITY | MOTOR_VELOCITY) { code = 107; }
                    else { match op {
                        ENABLE => { if m.kind == 5 && m.enabled { code = 4; } else if m.kind == 5 && m.stationary_count < 50 { code = 7; } else { m.enabled = true; m.fault = false; m.complete = false; m.target = if m.kind == 5 { 0. } else { m.position }; } }
                        DISABLE => { m.enabled = false; m.busy = false; m.complete = false; m.body = [0.; 3]; if m.kind == 5 { m.target = 0.; } }
                        STOP => { if !m.enabled { code = 3; } else { m.busy = false; m.complete = false; m.target = if m.kind == 5 { 0. } else { m.position }; m.body = [0.; 3]; } }
                        ZERO => { if m.kind == 4 { code = 10; } else if m.enabled { code = 4; } else { m.origin += m.position; m.position = 0.; m.target = 0.; m.fault = false; m.complete = false; if m.kind == 2 { m.limits[0] = -180.; m.limits[1] = 180.; } } }
                        MOTOR_VELOCITY => { let rpm = float(q, 12);
                            if !rpm.is_finite() { code = 5; } else if rpm.abs() > 300. { code = 6; }
                            else if m.fault { code = m.result; } else if !m.enabled { code = 3; }
                            else { m.target = rpm; m.busy = false; m.complete = false; if rpm.abs() > 0.1 { m.stationary_count = 0; } }
                        }
                        MOVE => { let target = float(q, 12);
                            if m.kind == 4 { code = 10; } else if !m.enabled { code = 3; } else if m.busy { code = 4; }
                            else if !target.is_finite() || (m.kind == 1 && (target + m.origin).abs() > 125. / 19.203 * 226.2 / std::f32::consts::TAU) || (m.kind == 2 && (target < m.limits[0] || target > m.limits[1])) { code = 6; }
                            else { m.target = target; m.busy = true; m.complete = false; }
                        }
                        VELOCITY => { let body = [float(q, 12), float(q, 16), float(q, 20)];
                            if m.kind != 4 { code = 10; } else if !m.enabled { code = 3; }
                            else if body.iter().any(|v| !v.is_finite()) || body[0].hypot(body[1]) > 1.000001 || body[2].abs() > 10. { code = 6; } else { m.body = body; }
                        }
                        LIMITS => {
                            if m.kind > 2 { code = 10; } else if m.enabled { code = 4; }
                            else { let count = if m.kind == 1 { 3 } else { 5 }; let mut limits = [0.; 5]; for (i, v) in limits[..count].iter_mut().enumerate() { *v = float(q, 12 + 4 * i); }
                                if limits[..count].iter().any(|v| !v.is_finite()) || limits[count - 3..count].iter().any(|v| *v <= 0.) || (count == 5 && (limits[0] < -180. || limits[1] > 180. || limits[0] >= limits[1])) { code = 5; } else { m.limits = limits; }
                            }
                        }
                        _ => { code = 10; }
                    } }
                    if !m.fault || code != 0 { m.result = code; }
                    result.push(response(q, m.id, code, 2));
                }
            }
        }
        for b in &mut result { seal(b); }
        self.cached = Some(*q); self.replies = result.clone(); result
    }
    fn state(q: &Frame, m: &Device, timeout: bool) -> Frame {
        let mut b = response(q, m.id, 0, if m.kind == 4 { 44 } else if m.kind == 5 { 32 } else { 48 });
        let (_, unit, bus) = definition(m.id).unwrap();
        put_u16(&mut b, 14, 1 | if bus == 1 { 2 | 4 } else { 0 } | if m.enabled { 8 } else { 0 } | if m.busy { 32 } else { 0 } | if m.complete { 64 } else { 0 } | if m.fault { 128 } else { 0 } | if timeout { 256 } else { 0 });
        b[16] = m.kind; b[17] = unit; b[18] = bus; put_u16(&mut b, 20, m.result); put_u16(&mut b, 22, if bus == 1 { u16::from(m.enabled) } else { 0xffff });
        put_u32(&mut b, 24, if m.kind == 4 { 0 } else { m.count });
        if m.kind == 4 { for (i, v) in m.body.iter().cycle().take(6).enumerate() { put_float(&mut b, 28 + 4 * i, *v); } b[52] = 15; b[53] = if m.enabled { 15 } else { 0 }; }
        else { let speed = if m.kind == 5 { if m.enabled { m.target } else { 0. } } else if !m.busy { 0. } else { (m.target - m.position).signum() * if m.kind == 1 { m.limits[0] } else { m.limits[2] } };
            for (p, v) in [(28, m.position), (32, speed), (36, m.target), (40, if m.kind == 5 { speed } else { m.position })] { put_float(&mut b, p, v); } if m.kind != 5 { put_float(&mut b, 44, speed); }
        } b
    }
    fn parameters(q: &Frame, m: &Device) -> Frame {
        let mut b = response(q, m.id, 0, if m.kind == 5 { 26 } else if m.kind == 4 { 30 } else { 48 });
        if m.kind == 5 { for (i, v) in [18., 0.1, 0., 8000., 300., 0.1].iter().enumerate() { put_float(&mut b, 14 + 4 * i, *v); } }
        else if m.kind == 4 { for (i, v) in [1., 1., 10., 160., 63.5, 435., 435.].iter().enumerate() { put_float(&mut b, 14 + 4 * i, *v); } }
        else { put_u16(&mut b, 14, if m.kind == 1 { 1 } else { 3 }); b[16] = m.kind; b[17] = if m.kind == 1 { 2 } else { 1 }; b[18] = 1;
            let values = if m.kind == 1 { [f32::NAN, f32::NAN, m.limits[0], m.limits[1], m.limits[2], 5., 0.5, 0., 0.1885, 1.1] } else { [m.limits[0], m.limits[1], m.limits[2], m.limits[3], m.limits[4], 5., 0.5, 0., 0.3, 0.1] };
            for (i, v) in values.iter().enumerate() { put_float(&mut b, 20 + i * 4, *v); }
        } b
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nine_devices_parameters_wheels_and_commands_are_valid() {
        let mut d = Demo::new(0); let mut seq = 0;
        for (op, id, values) in [(HEARTBEAT,255,vec![]),(INFO,255,vec![]),(STATE,255,vec![]),(PARAMETERS,0x0a,vec![]),(PARAMETERS,0x0d,vec![]),(PARAMETERS,0x21,vec![]),(PARAMETERS,0x40,vec![]),(LIMITS,0x0a,vec![1.,2.,3.]),(ZERO,0x0a,vec![]),(ENABLE,0x0a,vec![]),(MOVE,0x0a,vec![200.]),(ENABLE,0x40,vec![]),(VELOCITY,0x40,vec![0.4,0.,2.]),(WHEELS,0x40,vec![]),(DISABLE,255,vec![])] {
            seq += 1; let replies = d.handle(&request(seq,op,id,&values).unwrap(),seq as u64 * 10);
            assert_eq!(replies.len(),expected(op,id).len()); for b in replies { assert_eq!(validate(&b),Ok(())); assert_eq!(u16_at(&b,12),0); }
        }
    }
    #[test]
    fn timeout_exactly_500_and_cached_retry_cannot_clear_latch() {
        let mut d = Demo::new(0); let q = request(1,ENABLE,0x40,&[]).unwrap(); d.handle(&q,0);
        let before = d.handle(&request(2,STATE,0x40,&[]).unwrap(),499); assert_eq!(u16_at(&before[0],14)&256,0);
        let q2 = request(3,STATE,0x40,&[]).unwrap(); let timeout = d.handle(&q2,999); assert_ne!(u16_at(&timeout[0],14)&256,0);
        let retry = d.handle(&q2,1000); assert_eq!(retry,timeout);
        d.handle(&request(4,HEARTBEAT,255,&[]).unwrap(),1001);
        let enabled = d.handle(&request(5,ENABLE,0x40,&[]).unwrap(),1002); assert_eq!(u16_at(&enabled[0],12),0);
    }
    #[test]
    fn info_mapping_floats_units_and_move_limits_are_not_fabricated() {
        let mut d=Demo::new(0); let mut info=d.handle(&request(1,INFO,255,&[]).unwrap(),0)[0]; info[24]=0x0b; seal(&mut info); assert_eq!(validate(&info),Err(Issue::Structure));
        let mut state=d.handle(&request(2,STATE,0x0a,&[]).unwrap(),1)[0]; state[17]=1; seal(&mut state); assert_eq!(validate(&state),Err(Issue::Structure));
        let mut parameters=d.handle(&request(3,PARAMETERS,0x0a,&[]).unwrap(),2)[0]; put_float(&mut parameters,28,f32::INFINITY); seal(&mut parameters); assert_eq!(validate(&parameters),Err(Issue::Structure));
        d.handle(&request(4,ENABLE,0x0a,&[]).unwrap(),3);
        assert_eq!(u16_at(&d.handle(&request(5,MOVE,0x0a,&[235.]).unwrap(),4)[0],12),6);
        assert_eq!(u16_at(&d.handle(&request(6,MOVE,0x0a,&[-200.]).unwrap(),5)[0],12),0);
    }
    #[test]
    fn output_rpm_runs_continuously_reverses_stops_and_disables_without_old_target() {
        let mut demo = Demo::new(0); let mut sequence = 0;
        let mut send = |op, values: &[f32], now| {
            sequence += 1; let frame = demo.handle(&request(sequence, op, 0x21, values).unwrap(), now)[0];
            assert_eq!(validate(&frame), Ok(())); frame
        };
        assert_eq!(u16_at(&send(ENABLE, &[], 0), 12), 0);
        assert_eq!(u16_at(&send(MOTOR_VELOCITY, &[300.], 0), 12), 0);
        let mut moving = send(STATE, &[], 0);
        for now in [200, 400, 600, 800, 1000] { moving = send(STATE, &[], now); }
        assert!(float(&moving, 28) > 360.); assert_eq!(moving[16..20], [5, 4, 3, 0]);
        assert_eq!([float(&moving, 32), float(&moving, 36), float(&moving, 40)], [300.; 3]);
        assert_eq!(u16_at(&moving, 14) & (2 | 4 | 32 | 64), 0);
        assert_eq!(u16_at(&send(MOTOR_VELOCITY, &[-300.], 1000), 12), 0);
        let reversing = send(STATE, &[], 1200); assert!(float(&reversing, 28) < float(&moving, 28));
        assert_eq!(u16_at(&send(MOTOR_VELOCITY, &[301.], 1200), 12), 6);
        assert_eq!(float(&send(STATE, &[], 1200), 40), -300.);
        assert_eq!(u16_at(&send(MOVE, &[90.], 1200), 12), 105);
        assert_eq!(u16_at(&send(ZERO, &[], 1200), 12), 105);
        assert_eq!(u16_at(&send(STOP, &[], 1200), 12), 0);
        let stopped = send(STATE, &[], 1200); assert_ne!(u16_at(&stopped, 14) & 8, 0);
        assert_eq!([float(&stopped, 32), float(&stopped, 36), float(&stopped, 40)], [0.; 3]);
        assert_eq!(u16_at(&send(DISABLE, &[], 1200), 12), 0);
        assert_eq!(u16_at(&send(MOTOR_VELOCITY, &[20.], 1200), 12), 3);
        assert_eq!(u16_at(&send(ENABLE, &[], 1300), 12), 0);
        assert_eq!(float(&send(STATE, &[], 1300), 36), 0.);
    }

    #[test]
    fn speed_descriptor_rejects_old_firmware_and_timeout_needs_explicit_restart() {
        let mut demo = Demo::new(0); let mut sequence = 0;
        let mut send = |op, id, values: &[f32], now| {
            sequence += 1; demo.handle(&request(sequence, op, id, values).unwrap(), now)[0]
        };
        let mut info = send(INFO, 255, &[], 0); info[39] = 3; info[40] = 3; seal(&mut info);
        assert_eq!(validate(&info), Err(Issue::Structure));
        let mut parameters = send(PARAMETERS, 0x21, &[], 0); assert_eq!(u16_at(&parameters, 8), 26);
        assert_eq!(float(&parameters, 30), 300.); put_u16(&mut parameters, 8, 50); seal(&mut parameters);
        assert_eq!(validate(&parameters), Err(Issue::Structure));
        assert_eq!(u16_at(&send(MOTOR_VELOCITY, 0x0a, &[90.], 0), 12), 105);
        send(ENABLE, 0x21, &[], 0); send(MOTOR_VELOCITY, 0x21, &[200.], 0);
        let fault = send(STATE, 0x21, &[], 500); assert_ne!(u16_at(&fault, 14) & 128, 0); assert_eq!(float(&fault, 36), 0.);
        assert_eq!(u16_at(&send(ENABLE, 0x21, &[], 500), 12), 107);
        send(HEARTBEAT, 255, &[], 500); assert_eq!(u16_at(&send(DISABLE, 0x21, &[], 500), 12), 0);
        assert_eq!(u16_at(&send(ENABLE, 0x21, &[], 500), 12), 7);
        let disabled = send(STATE, 0x21, &[], 600); assert_eq!(u16_at(&disabled, 14) & 8, 0);
        assert_eq!(u16_at(&send(ENABLE, 0x21, &[], 600), 12), 0);
        let recovered = send(STATE, 0x21, &[], 600); assert_eq!(u16_at(&recovered, 14) & 128, 0); assert_eq!(float(&recovered, 36), 0.);
    }
    #[test]
    fn invalid_speed_payload_preserves_the_last_valid_reference() {
        let mut demo = Demo::new(0);
        demo.handle(&request(1, ENABLE, 0x22, &[]).unwrap(), 0);
        demo.handle(&request(2, MOTOR_VELOCITY, 0x22, &[100.]).unwrap(), 0);
        for (index, value) in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY].into_iter().enumerate() {
            let mut q = request(3 + index as u16, MOTOR_VELOCITY, 0x22, &[0.]).unwrap();
            put_float(&mut q, 12, value); seal(&mut q);
            assert_eq!(u16_at(&demo.handle(&q, 0)[0], 12), 5);
        }
        let invalid_length = request(6, MOTOR_VELOCITY, 0x22, &[]).unwrap();
        assert_eq!(u16_at(&demo.handle(&invalid_length, 0)[0], 12), 102);
        let state = demo.handle(&request(7, STATE, 0x22, &[]).unwrap(), 0)[0];
        assert_eq!(float(&state, 36), 100.); assert_eq!(float(&state, 40), 100.);
    }
}
