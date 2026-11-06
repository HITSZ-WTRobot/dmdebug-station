use serde::Serialize;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

const TIMEOUT: Duration = Duration::from_secs(3);
const CPUID: u32 = 0xE000_ED00;
static NEXT_MARKER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OzoneMirror {
    expression: String,
    address: u32,
    value: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OzoneParameter {
    key: String,
    label: String,
    unit: String,
    expression: String,
    address: u32,
    value: f32,
    mirrors: Vec<OzoneMirror>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OzoneSnapshot {
    device_id: u32,
    parameters: Vec<OzoneParameter>,
}

#[derive(Clone, Default)]
pub struct OzoneState {
    session: Arc<Mutex<Option<Session>>>,
}

struct Session {
    socket: TcpStream,
    pending: Vec<u8>,
    timeout: Duration,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

struct ParameterSpec {
    key: &'static str,
    label: &'static str,
    unit: &'static str,
    primary: String,
    mirrors: Vec<String>,
}

fn root(device_id: u32) -> Result<String, String> {
    match device_id {
        0x0a..=0x0f => Ok(format!("dm_motors[{}]", device_id - 0x0a)),
        0x21 | 0x22 => Ok(format!("m2006_motors[{}]", device_id - 0x21)),
        _ => Err("Ozone仅支持设备0x0A..0x0F、0x21、0x22".into()),
    }
}

fn catalog(device_id: u32) -> Result<Vec<ParameterSpec>, String> {
    let root = root(device_id)?;
    let mut specs = Vec::new();
    let mut add = |key, label, unit, primary: String, mirror: Option<String>| {
        specs.push(ParameterSpec { key, label, unit, primary: format!("{root}->{primary}"),
            mirrors: mirror.into_iter().map(|field| format!("{root}->{field}")).collect() });
    };
    if device_id < 0x21 {
        for (key, label, unit) in [
            ("kp", "位置Kp", ""), ("kd", "速度Kd", ""), ("torque_ff_nm", "前馈扭矩", "N·m"),
            ("finish_deg", "到位阈值", "deg"), ("stationary_rpm", "静止阈值", "rpm"),
        ] { add(key, label, unit, format!("control_.{key}"), None); }
        for (key, label, unit) in [
            ("min_deg", "最小位置", "deg"), ("max_deg", "最大位置", "deg"),
            ("max_velocity_deg_s", "最大速度", "deg/s"), ("max_acceleration_deg_s2", "最大加速度", "deg/s²"),
            ("max_jerk_deg_s3", "最大加加速度", "deg/s³"),
        ] {
            if matches!(device_id, 0x0d | 0x0f) || !matches!(key, "min_deg" | "max_deg") {
                add(key, label, unit, format!("limits_.{key}"), Some(key.to_string()));
            }
        }
    } else {
        for (key, label, field) in [
            ("velocity_kp", "速度Kp", "Kp"), ("velocity_ki", "速度Ki", "Ki"),
            ("velocity_kd", "速度Kd", "Kd"), ("velocity_output_max", "速度输出限幅", "abs_output_max"),
        ] { add(key, label, "", format!("controller_.pid_.cfg_.{field}"), Some(format!("config_.velocity_pid.{field}"))); }
        add("max_rpm", "最大输出轴转速", "rpm", "config_.max_rpm".into(), None);
        add("stationary_rpm", "静止阈值", "rpm", "config_.stationary_rpm".into(), None);
    }
    Ok(specs)
}

fn validate_address(address: u32, width: u32) -> Result<(), String> {
    // 白名单与本工程STM32H723xx_FLASH.ld一致，不接受用户传入地址。
    const REGIONS: [(u32, u32); 5] = [
        (0x2000_0000, 128 * 1024), (0x2400_0000, 128 * 1024),
        (0x2402_0000, 192 * 1024), (0x3000_0000, 32 * 1024), (0x3800_0000, 16 * 1024),
    ];
    let valid = matches!(width, 1 | 4) && address % width == 0 && address.checked_add(width).is_some_and(|end| {
        REGIONS.iter().any(|&(start, size)| address >= start && end <= start + size)
    });
    if valid { Ok(()) } else { Err(format!("地址0x{address:08X}不在本工程RAM白名单内或未按{width}字节对齐")) }
}

fn compact(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

fn number(text: &str) -> Result<(u32, &str), String> {
    let (digits, radix, prefix) = if text.starts_with("0x") || text.starts_with("0X") {
        (&text[2..], 16, 2)
    } else { (text, 10, 0) };
    let length = digits.bytes().take_while(|c| if radix == 16 { c.is_ascii_hexdigit() } else { c.is_ascii_digit() }).count();
    if length == 0 { return Err("Ozone回复中的数值无效".into()); }
    let value = u32::from_str_radix(&digits[..length], radix).map_err(|_| "Ozone回复数值超出u32范围".to_string())?;
    Ok((value, &text[prefix + length..]))
}

fn parse_reply(expression: &str, response: &str) -> Result<u32, String> {
    let expected = compact(expression);
    for line in response.lines() {
        let line = compact(line).to_ascii_lowercase();
        if ["error", "failed", "failure", "unknowncommand", "syntaxerror"].iter().any(|prefix| line.starts_with(prefix)) {
            return Err("Ozone报告命令错误；结果可能不确定，连接已撤销，不自动重试".into());
        }
    }
    let prefix = format!("{expected};//returns");
    for line in response.lines() {
        let line = compact(line);
        if let Some(start) = line.find(&prefix) {
            let (result, rest) = number(&line[start + prefix.len()..])?;
            let width = if expression.starts_with("Target.ReadU8") { Some(1) }
                else if expression.starts_with("Target.ReadU32") { Some(4) } else { None };
            if let Some(width) = width {
                if result != width { return Err(format!("Ozone内存读取返回字节数不为{width}")); }
                let data = rest.strip_prefix(",datais").ok_or("Ozone内存读取缺少data is数值")?;
                let (value, rest) = number(data)?;
                if !rest.is_empty() || (width == 1 && value > 255) { return Err("Ozone内存读取返回格式不匹配".into()); }
                return Ok(value);
            }
            if !rest.is_empty() { return Err("Ozone命令返回格式不匹配".into()); }
            if expression.starts_with("Target.WriteU32") && result != 0 && result != 4 {
                return Err(format!("Ozone写入返回{result}，结果可能不确定；不自动重试"));
            }
            return Ok(result);
        }
    }
    // Ozone 3.50写成功可能只回显命令，仍须先等完整独立marker行。
    if expression.starts_with("Target.WriteU32") && response.lines().any(|line| compact(line) == format!("{expected};")) { return Ok(0); }
    Err("Ozone没有返回匹配的命令结果；连接已撤销，不自动重试".into())
}

fn remaining(deadline: Instant) -> Result<Duration, String> {
    deadline.checked_duration_since(Instant::now()).filter(|duration| !duration.is_zero())
        .ok_or_else(|| "Ozone操作超时；结果可能不确定，不自动重试，请重新连接并读取".into())
}

impl Session {
    fn open(address: SocketAddr, timeout: Duration) -> Result<Self, String> {
        let socket = TcpStream::connect_timeout(&address, timeout).map_err(|error| format!("连接Ozone失败：{error}"))?;
        socket.set_nodelay(true).map_err(|error| format!("设置Ozone连接失败：{error}"))?;
        Ok(Self { socket, pending: Vec::new(), timeout })
    }

    fn evaluate(&mut self, expression: &str, deadline: Instant) -> Result<u32, String> {
        let marker = format!("OZDM{:016X}", NEXT_MARKER.fetch_add(1, Ordering::Relaxed));
        let request = format!("{expression};\nUtil.Log(\"{marker}\");\n");
        self.socket.set_write_timeout(Some(remaining(deadline)?)).map_err(|error| format!("设置Ozone写超时失败：{error}"))?;
        self.socket.write_all(request.as_bytes()).map_err(|error| format!("Ozone发送失败：{error}；结果可能不确定，不自动重试"))?;
        loop {
            let mut start = 0;
            let mut marker_end = None;
            for (index, byte) in self.pending.iter().enumerate() {
                if *byte == b'\n' {
                    let line = &self.pending[start..index];
                    let line = line.strip_suffix(b"\r").unwrap_or(line);
                    let end = line.iter().rposition(|c| *c != b' ' && *c != b'\t').map_or(0, |i| i + 1);
                    if &line[..end] == marker.as_bytes() { marker_end = Some(index + 1); break; }
                    start = index + 1;
                }
            }
            if let Some(end) = marker_end {
                let response = std::str::from_utf8(&self.pending[..end]).map_err(|_| "Ozone返回非UTF-8协议数据".to_string())?;
                let result = parse_reply(expression, response);
                self.pending.drain(..end);
                return result;
            }
            if self.pending.len() >= 262144 { return Err("Ozone返回数据过多，协议不同步".into()); }
            self.socket.set_read_timeout(Some(remaining(deadline)?)).map_err(|error| format!("设置Ozone读超时失败：{error}"))?;
            let mut buffer = [0u8; 8192];
            match self.socket.read(&mut buffer) {
                Ok(0) => return Err("Ozone关闭连接；结果可能不确定，不自动重试".into()),
                Ok(length) => self.pending.extend_from_slice(&buffer[..length]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(format!("Ozone回复超时或连接中断：{error}；未收到完整结束标记，结果可能不确定，不自动重试")),
            }
        }
    }

    fn read_word(&mut self, address: u32, deadline: Instant) -> Result<u32, String> {
        self.evaluate(&format!("Target.ReadU32(0x{address:X})"), deadline)
    }

    fn write_word(&mut self, address: u32, value: u32, deadline: Instant) -> Result<f32, String> {
        self.evaluate(&format!("Target.WriteU32(0x{address:X}, 0x{value:X})"), deadline)?;
        let actual = self.read_word(address, deadline)?;
        if actual != value { return Err(format!("写入0x{address:08X}后读回0x{actual:08X}与期望0x{value:08X}不一致")); }
        Ok(f32::from_bits(actual))
    }

    fn address(&mut self, expression: &str, width: u32, deadline: Instant) -> Result<u32, String> {
        let address = self.evaluate(&format!("Elf.GetExprValue(\"&{expression}\")"), deadline)?;
        validate_address(address, width)?;
        Ok(address)
    }

    fn target(&mut self, device_id: u32, deadline: Instant) -> Result<(u32, u32), String> {
        let cpuid = self.read_word(CPUID, deadline)?;
        if (cpuid >> 4) & 0xfff != 0xc27 { return Err(format!("CPUID 0x{cpuid:08X}不是Cortex-M7(part C27)")); }
        let slot = self.address(&root(device_id)?, 4, deadline)?;
        let pointer = self.read_word(slot, deadline)?;
        validate_address(pointer, 4)?;
        Ok((slot, pointer))
    }

    fn verify_root(&mut self, slot: u32, pointer: u32, deadline: Instant) -> Result<(), String> {
        if self.read_word(slot, deadline)? != pointer { return Err("操作期间设备对象指针改变，本次结果丢弃，请重新连接读取".into()); }
        Ok(())
    }

    fn resolve(&mut self, spec: &ParameterSpec, deadline: Instant) -> Result<OzoneParameter, String> {
        let address = self.address(&spec.primary, 4, deadline)?;
        let mut mirrors = Vec::with_capacity(spec.mirrors.len());
        for expression in &spec.mirrors {
            mirrors.push(OzoneMirror { expression: expression.clone(), address: self.address(expression, 4, deadline)?, value: 0.0 });
        }
        Ok(OzoneParameter { key: spec.key.into(), label: spec.label.into(), unit: spec.unit.into(),
            expression: spec.primary.clone(), address, value: 0.0, mirrors })
    }

    fn read_float(&mut self, address: u32, deadline: Instant) -> Result<f32, String> {
        let value = f32::from_bits(self.read_word(address, deadline)?);
        if !value.is_finite() { return Err(format!("参数0x{address:08X}不是有限float32")); }
        Ok(value)
    }

    fn diagnose(&mut self) -> Result<String, String> {
        let deadline = Instant::now() + self.timeout;
        let (slot, pointer) = self.target(0x0a, deadline)?;
        let spec = catalog(0x0a)?.remove(0);
        let address = self.address(&spec.primary, 4, deadline)?;
        self.read_float(address, deadline)?;
        self.verify_root(slot, pointer, deadline)?;
        Ok(format!("只读诊断通过：127.0.0.1:19200，Cortex-M7，{}=0x{address:08X}可读。不保证目标运行状态或其他C++私有字段布局；写入将直接修改活跃内存，多字段非原子。", spec.primary))
    }

    fn read_parameters(&mut self, device_id: u32) -> Result<OzoneSnapshot, String> {
        let specs = catalog(device_id)?;
        let deadline = Instant::now() + self.timeout;
        let (slot, pointer) = self.target(device_id, deadline)?;
        let mut parameters = Vec::with_capacity(specs.len());
        for spec in &specs {
            let mut parameter = self.resolve(spec, deadline)?;
            parameter.value = self.read_float(parameter.address, deadline)?;
            for mirror in &mut parameter.mirrors { mirror.value = self.read_float(mirror.address, deadline)?; }
            parameters.push(parameter);
        }
        self.verify_root(slot, pointer, deadline)?;
        Ok(OzoneSnapshot { device_id, parameters })
    }

    fn write_parameter(&mut self, device_id: u32, spec: &ParameterSpec, value: f32) -> Result<OzoneParameter, String> {
        let deadline = Instant::now() + self.timeout;
        let (slot, pointer) = self.target(device_id, deadline)?;
        // 所有实际字段和配置镜像都先通过当前ELF解析、校验，绝不硬编码成员偏移。
        let mut parameter = self.resolve(spec, deadline)?;
        self.verify_root(slot, pointer, deadline)?;
        parameter.value = self.write_word(parameter.address, value.to_bits(), deadline)?;
        for mirror in &mut parameter.mirrors { mirror.value = self.write_word(mirror.address, value.to_bits(), deadline)?; }
        self.verify_root(slot, pointer, deadline)?;
        Ok(parameter)
    }
}

impl OzoneState {
    fn with_session<T>(&self, action: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.session.lock().map_err(|_| "Ozone会话互斥锁异常".to_string())?;
        let session = guard.as_mut().ok_or("尚未连接Ozone，请先执行只读诊断")?;
        let result = action(session);
        // 错误后立即释放socket；写授权仅来自本次IPC，不保存在会话中。
        if result.is_err() { guard.take(); }
        result
    }

    fn connect(&self) -> Result<String, String> {
        let mut guard = self.session.lock().map_err(|_| "Ozone会话互斥锁异常".to_string())?;
        guard.take();
        let mut session = Session::open(SocketAddr::from(([127, 0, 0, 1], 19200)), TIMEOUT)?;
        let diagnostic = session.diagnose()?;
        *guard = Some(session);
        Ok(diagnostic)
    }

    fn disconnect(&self) -> Result<(), String> {
        self.session.lock().map_err(|_| "Ozone会话互斥锁异常".to_string())?.take();
        Ok(())
    }

    fn read_parameters(&self, device_id: u32) -> Result<OzoneSnapshot, String> {
        root(device_id)?;
        self.with_session(|session| session.read_parameters(device_id))
    }

    fn write_parameter(&self, device_id: u32, key: &str, value: f32, authorized: bool) -> Result<OzoneParameter, String> {
        if !authorized { return Err("本次操作未授权直接内存写入，未发送任何命令".into()); }
        if !value.is_finite() { return Err("参数必须是有限float32，未发送任何命令".into()); }
        let spec = catalog(device_id)?.into_iter().find(|spec| spec.key == key).ok_or("设备不支持该固定参数key，未发送任何命令")?;
        self.with_session(|session| session.write_parameter(device_id, &spec, value))
            .map_err(|error| format!("直接写入失败：{error}。可能已部分写入，不回滚、不自动重试；连接与本次授权已撤销，请重新连接读取实际值。"))
    }
}

async fn blocking<T: Send + 'static>(action: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(action).await.map_err(|error| format!("Ozone工作线程失败：{error}"))?
}

#[tauri::command]
pub async fn ozone_connect(state: State<'_, OzoneState>) -> Result<String, String> {
    let state = state.inner().clone();
    blocking(move || state.connect()).await
}

#[tauri::command]
pub async fn ozone_disconnect(state: State<'_, OzoneState>) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || state.disconnect()).await
}

#[tauri::command]
pub async fn ozone_read_parameters(state: State<'_, OzoneState>, device_id: u32) -> Result<OzoneSnapshot, String> {
    let state = state.inner().clone();
    blocking(move || state.read_parameters(device_id)).await
}

#[tauri::command]
pub async fn ozone_write_parameter(state: State<'_, OzoneState>, device_id: u32, key: String, value: f32, authorized: bool) -> Result<OzoneParameter, String> {
    let state = state.inner().clone();
    blocking(move || state.write_parameter(device_id, &key, value, authorized)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::thread::{self, JoinHandle};

    const BASE: u32 = 0x2402_0000;
    type Trace = Arc<Mutex<Vec<String>>>;

    fn mock(handler: impl FnMut(&str, &str) -> String + Send + 'static, timeout: Duration) -> (OzoneState, Trace, JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let trace = Arc::new(Mutex::new(Vec::new()));
        let server_trace = Arc::clone(&trace);
        let worker = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_nodelay(true).unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut handler = handler;
            loop {
                let mut expression = String::new();
                match reader.read_line(&mut expression) {
                    Ok(0) => break,
                    Ok(_) => {},
                    Err(error) if matches!(error.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted) => break,
                    Err(error) => panic!("mock read failed: {error}"),
                }
                let mut marker = String::new();
                reader.read_line(&mut marker).unwrap();
                let marker = marker.trim().strip_prefix("Util.Log(\"").unwrap().strip_suffix("\");").unwrap();
                let expression = expression.trim().strip_suffix(';').unwrap();
                server_trace.lock().unwrap().push(expression.to_string());
                let response = handler(expression, marker);
                if socket.write_all(response.as_bytes()).is_err() { break; }
            }
        });
        let session = Session::open(address, timeout).unwrap();
        (OzoneState { session: Arc::new(Mutex::new(Some(session))) }, trace, worker)
    }

    fn finish(state: &OzoneState, worker: JoinHandle<()>) {
        state.disconnect().unwrap();
        worker.join().unwrap();
    }

    fn reply(expression: &str, result: &str, marker: &str) -> String {
        format!("{expression}; // returns {result}\r\n{marker}\r\n")
    }

    struct Target {
        symbols: BTreeMap<String, u32>,
        memory: BTreeMap<u32, u32>,
        fail_write: Option<u32>,
        corrupt_write: Option<u32>,
    }

    impl Target {
        fn new(device_id: u32) -> Self {
            let mut symbols = BTreeMap::new();
            let mut memory = BTreeMap::new();
            symbols.insert(root(device_id).unwrap(), BASE);
            memory.insert(BASE, BASE + 0x1000);
            memory.insert(CPUID, 0x411f_c271);
            for (index, spec) in catalog(device_id).unwrap().into_iter().enumerate() {
                let address = BASE + 0x2000 + index as u32 * 8;
                symbols.insert(spec.primary, address);
                memory.insert(address, 1.5_f32.to_bits());
                for mirror in spec.mirrors {
                    symbols.insert(mirror, address + 4);
                    memory.insert(address + 4, 2.5_f32.to_bits());
                }
            }
            Self { symbols, memory, fail_write: None, corrupt_write: None }
        }

        fn respond(&mut self, expression: &str, marker: &str) -> String {
            if let Some(symbol) = expression.strip_prefix("Elf.GetExprValue(\"&").and_then(|s| s.strip_suffix("\")")) {
                return reply(expression, &format!("0x{:X}", self.symbols[symbol]), marker);
            }
            for (prefix, width) in [("Target.ReadU32(", 4), ("Target.ReadU8(", 1)] {
                if let Some(address) = expression.strip_prefix(prefix).and_then(|s| s.strip_suffix(')')) {
                    let value = self.memory[&number(address).unwrap().0];
                    return reply(expression, &format!("{width}, data is 0x{value:X}"), marker);
                }
            }
            let inner = expression.strip_prefix("Target.WriteU32(").unwrap().strip_suffix(')').unwrap();
            let (address, value) = inner.split_once(',').unwrap();
            let address = number(address).unwrap().0;
            let value = number(value.trim()).unwrap().0;
            if self.fail_write == Some(address) { return reply(expression, "3", marker); }
            self.memory.insert(address, if self.corrupt_write == Some(address) { value ^ 1 } else { value });
            format!("{expression};\r\n{marker}\r\n")
        }
    }

    fn target_mock(target: Target) -> (OzoneState, Trace, JoinHandle<()>, Arc<Mutex<Target>>) {
        let target = Arc::new(Mutex::new(target));
        let server = Arc::clone(&target);
        let (state, trace, worker) = mock(move |expression, marker| server.lock().unwrap().respond(expression, marker), TIMEOUT);
        (state, trace, worker, target)
    }

    #[test]
    fn split_numeric_reply_and_standalone_marker_are_accumulated() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_nodelay(true).unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut expression = String::new();
            let mut log = String::new();
            reader.read_line(&mut expression).unwrap();
            reader.read_line(&mut log).unwrap();
            let marker = log.trim().strip_prefix("Util.Log(\"").unwrap().strip_suffix("\");").unwrap();
            socket.write_all(format!("{log}Target.ReadU32 (0x24020000); // returns 4, data is 0x12").as_bytes()).unwrap();
            thread::sleep(Duration::from_millis(10));
            socket.write_all(format!("345678\r\n{marker}").as_bytes()).unwrap();
            thread::sleep(Duration::from_millis(10));
            socket.write_all(b"\r\n").unwrap();
        });
        let mut session = Session::open(address, TIMEOUT).unwrap();
        assert_eq!(session.read_word(BASE, Instant::now() + TIMEOUT).unwrap(), 0x1234_5678);
        drop(session);
        worker.join().unwrap();
    }

    #[test]
    fn writes_accept_echo_or_zero_or_four_and_verify_float_bits() {
        for response in ["echo", "0", "4"] {
            let (state, _, worker) = mock(move |expression, marker| {
                if expression.starts_with("Target.Read") { reply(expression, "4, data is 0x80000000", marker) }
                else if response == "echo" { format!("{expression};\n{marker}\n") }
                else { reply(expression, response, marker) }
            }, TIMEOUT);
            let value = state.with_session(|session| session.write_word(BASE, (-0.0_f32).to_bits(), Instant::now() + TIMEOUT)).unwrap();
            assert_eq!(value.to_bits(), (-0.0_f32).to_bits());
            finish(&state, worker);
        }
    }

    #[test]
    fn protocol_errors_close_session_without_retry() {
        for response in ["2, data is 0x99", "4", "4, data is invalid", "wrong", "error", "unknown"] {
            let (state, trace, worker) = mock(move |expression, marker| match response {
                "wrong" => reply("Target.ReadU32(0x20000000)", "4, data is 0", marker),
                "error" => format!("{expression};\nERROR: target unavailable\n{marker}\n"),
                "unknown" => format!("Unknown command\n{expression};\n{marker}\n"),
                _ => reply(expression, response, marker),
            }, TIMEOUT);
            assert!(state.with_session(|session| session.read_word(BASE, Instant::now() + TIMEOUT)).is_err());
            assert!(state.session.lock().unwrap().is_none());
            assert_eq!(trace.lock().unwrap().len(), 1);
            finish(&state, worker);
        }
    }

    #[test]
    fn incomplete_marker_times_out_and_closes_without_retry() {
        let timeout = Duration::from_millis(60);
        let (state, trace, worker) = mock(|expression, marker| format!("{expression}; // returns 4, data is 1\n{marker}"), timeout);
        assert!(state.with_session(|session| session.read_word(BASE, Instant::now() + timeout)).is_err());
        assert!(state.session.lock().unwrap().is_none());
        assert_eq!(trace.lock().unwrap().len(), 1);
        finish(&state, worker);
    }

    #[test]
    fn unauthorized_invalid_keys_devices_and_nonfinite_values_send_zero_commands() {
        let (state, trace, worker, _) = target_mock(Target::new(0x0a));
        assert!(state.write_parameter(0x0a, "kp", 1.0, false).is_err());
        assert!(state.write_parameter(0x0a, "kp", f32::NAN, true).is_err());
        assert!(state.write_parameter(0x0a, "kp", f32::INFINITY, true).is_err());
        assert!(state.write_parameter(0xff, "kp", 1.0, true).is_err());
        assert!(state.write_parameter(0x0a, "min_deg", 1.0, true).is_err());
        assert!(state.write_parameter(0x0a, "kp;Target.Run()", 1.0, true).is_err());
        assert!(trace.lock().unwrap().is_empty());
        finish(&state, worker);
    }

    #[test]
    fn reads_all_device_catalogs_and_only_allowed_commands() {
        for id in [0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x21, 0x22] {
            let (state, trace, worker, _) = target_mock(Target::new(id));
            let snapshot = state.read_parameters(id).unwrap();
            assert_eq!(snapshot.device_id, id);
            assert_eq!(snapshot.parameters.len(), if id >= 0x21 { 6 } else if matches!(id, 0x0d | 0x0f) { 10 } else { 8 });
            for parameter in &snapshot.parameters {
                assert_eq!(parameter.value, 1.5);
                assert!(parameter.mirrors.iter().all(|mirror| mirror.value == 2.5));
            }
            assert!(trace.lock().unwrap().iter().all(|command| command.starts_with("Elf.GetExprValue(\"&") || command.starts_with("Target.ReadU32(") || command.starts_with("Target.ReadU8(")));
            finish(&state, worker);
        }
    }

    #[test]
    fn dm_actual_control_and_limits_mirrors_are_written_not_staged() {
        let (state, trace, worker, target) = target_mock(Target::new(0x0d));
        let kp = state.write_parameter(0x0d, "kp", -99.0, true).unwrap();
        assert_eq!(kp.expression, "dm_motors[3]->control_.kp");
        assert_eq!(kp.value, -99.0);
        assert!(kp.mirrors.is_empty());
        let limit = state.write_parameter(0x0d, "max_velocity_deg_s", 17.25, true).unwrap();
        assert_eq!(limit.expression, "dm_motors[3]->limits_.max_velocity_deg_s");
        assert_eq!(limit.mirrors[0].expression, "dm_motors[3]->max_velocity_deg_s");
        assert_eq!(target.lock().unwrap().memory[&limit.address], 17.25_f32.to_bits());
        assert_eq!(target.lock().unwrap().memory[&limit.mirrors[0].address], 17.25_f32.to_bits());
        let trace = trace.lock().unwrap();
        let writes: Vec<_> = trace.iter().filter(|command| command.starts_with("Target.Write")).collect();
        assert_eq!(writes.len(), 3);
        for write in writes {
            let index = trace.iter().position(|command| command == write).unwrap();
            let address = write.strip_prefix("Target.WriteU32(").unwrap().split(',').next().unwrap();
            assert_eq!(trace[index + 1], format!("Target.ReadU32({address})"));
        }
        assert!(trace.iter().all(|command| !command.contains("motor_tuning") && !command.contains("Run(") && !command.contains("Halt(")));
        drop(trace);
        finish(&state, worker);
    }

    #[test]
    fn m2006_speed_fields_read_back_primary_and_configuration_values() {
        let (state, _, worker, _) = target_mock(Target::new(0x22));
        let snapshot = state.read_parameters(0x22).unwrap();
        assert_eq!(snapshot.parameters.len(), 6);
        for parameter in snapshot.parameters {
            let result = state.write_parameter(0x22, &parameter.key, -0.0, true).unwrap();
            assert_eq!(result.value.to_bits(), (-0.0_f32).to_bits());
            assert_eq!(result.mirrors.len(), usize::from(parameter.key.starts_with("velocity_")));
            assert!(result.mirrors.iter().all(|mirror| mirror.value.to_bits() == (-0.0_f32).to_bits()));
        }
        for key in ["position_kp", "profile_max_spd", "finish_deg"] {
            assert!(state.write_parameter(0x22, key, 1.0, true).is_err());
        }
        finish(&state, worker);
    }

    #[test]
    fn invalid_pointer_field_address_and_cpuid_reject_before_write() {
        for invalid in 0..4 {
            let mut target = Target::new(0x21);
            match invalid {
                0 => { target.memory.insert(BASE, 0); },
                1 => { target.memory.insert(CPUID, 0x410f_c241); },
                2 => { target.symbols.insert("m2006_motors[0]->controller_.pid_.cfg_.Kp".into(), 0x0800_0000); },
                _ => { target.symbols.insert("m2006_motors[0]->config_.velocity_pid.Kp".into(), BASE + 1); },
            }
            let (state, trace, worker, _) = target_mock(target);
            assert!(state.write_parameter(0x21, "velocity_kp", 1.0, true).is_err());
            assert!(trace.lock().unwrap().iter().all(|command| !command.starts_with("Target.Write")));
            assert!(state.session.lock().unwrap().is_none());
            finish(&state, worker);
        }
        for (start, size) in [(0x2000_0000, 128 * 1024), (0x2400_0000, 128 * 1024), (0x2402_0000, 192 * 1024), (0x3000_0000, 32 * 1024), (0x3800_0000, 16 * 1024)] {
            assert!(validate_address(start, 4).is_ok());
            assert!(validate_address(start + size - 4, 4).is_ok());
        }
        assert!(validate_address(0x3800_4000, 4).is_err());
        assert!(validate_address(u32::MAX - 3, 4).is_err());
    }

    #[test]
    fn readback_failure_stops_without_mirror_or_retry() {
        let mut target = Target::new(0x21);
        target.corrupt_write = Some(BASE + 0x2000);
        let (state, trace, worker, _) = target_mock(target);
        let error = state.write_parameter(0x21, "velocity_kp", 3.0, true).unwrap_err();
        assert!(error.contains("可能已部分写入"));
        assert!(error.contains("不自动重试"));
        assert_eq!(trace.lock().unwrap().iter().filter(|command| command.starts_with("Target.Write")).count(), 1);
        assert!(state.session.lock().unwrap().is_none());
        finish(&state, worker);
    }

    #[test]
    fn mirror_failure_reports_partial_write_and_preserves_observed_primary() {
        let mut target = Target::new(0x21);
        target.fail_write = Some(BASE + 0x2004);
        let (state, trace, worker, target) = target_mock(target);
        let error = state.write_parameter(0x21, "velocity_kp", 3.0, true).unwrap_err();
        assert!(error.contains("可能已部分写入"));
        assert!(error.contains("不回滚"));
        let target = target.lock().unwrap();
        assert_eq!(target.memory[&(BASE + 0x2000)], 3.0_f32.to_bits());
        assert_eq!(target.memory[&(BASE + 0x2004)], 2.5_f32.to_bits());
        assert_eq!(trace.lock().unwrap().iter().filter(|command| command.starts_with("Target.Write")).count(), 2);
        assert!(state.session.lock().unwrap().is_none());
        drop(target);
        finish(&state, worker);
    }

    #[test]
    fn diagnostics_are_read_only_and_do_not_claim_target_running() {
        let (state, trace, worker, _) = target_mock(Target::new(0x0a));
        let diagnostic = state.with_session(|session| session.diagnose()).unwrap();
        assert!(diagnostic.contains("不保证目标运行状态"));
        assert!(trace.lock().unwrap().iter().all(|command| !command.starts_with("Target.Write")));
        finish(&state, worker);
    }

    #[test]
    fn each_write_resolves_current_elf_instead_of_reusing_previous_addresses() {
        let (state, trace, worker, target) = target_mock(Target::new(0x0a));
        let first = state.write_parameter(0x0a, "kp", 3.0, true).unwrap();
        let replacement = BASE + 0x4000;
        {
            let mut target = target.lock().unwrap();
            target.symbols.insert("dm_motors[0]->control_.kp".into(), replacement);
            target.memory.insert(replacement, 1.0_f32.to_bits());
        }
        let second = state.write_parameter(0x0a, "kp", 4.0, true).unwrap();
        assert_eq!(second.address, replacement);
        let target = target.lock().unwrap();
        assert_eq!(target.memory[&first.address], 3.0_f32.to_bits());
        assert_eq!(target.memory[&second.address], 4.0_f32.to_bits());
        assert_eq!(trace.lock().unwrap().iter().filter(|command| command.as_str() == "Elf.GetExprValue(\"&dm_motors[0]->control_.kp\")").count(), 2);
        drop(target);
        finish(&state, worker);
    }

    #[test]
    fn changed_root_after_write_discards_success_and_closes_session() {
        let mut target = Target::new(0x0a);
        let mut root_reads = 0;
        let (state, trace, worker) = mock(move |expression, marker| {
            if expression == "Target.ReadU32(0x24020000)" {
                root_reads += 1;
                if root_reads == 3 { target.memory.insert(BASE, BASE + 0x5000); }
            }
            target.respond(expression, marker)
        }, TIMEOUT);
        let error = state.write_parameter(0x0a, "kp", 3.0, true).unwrap_err();
        assert!(error.contains("指针改变"));
        assert!(error.contains("可能已部分写入"));
        assert_eq!(trace.lock().unwrap().iter().filter(|command| command.starts_with("Target.Write")).count(), 1);
        assert!(state.session.lock().unwrap().is_none());
        finish(&state, worker);
    }
}
