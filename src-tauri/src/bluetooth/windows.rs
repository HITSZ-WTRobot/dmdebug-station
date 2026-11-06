use super::{format_address, parse_address, BluetoothDevice};
use std::io::{self, ErrorKind};
use std::mem::size_of;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use windows_sys::core::GUID;
use windows_sys::Win32::Devices::Bluetooth::*;
use windows_sys::Win32::Foundation::{GetLastError, ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
use windows_sys::Win32::Networking::WinSock as ws;

const SPP: GUID = GUID::from_u128(0x00001101_0000_1000_8000_00805f9b34fb);
const CANCEL_SLICE: Duration = Duration::from_millis(10);
const CONNECTION_HINT: &str = "请确认Windows已配对、设备供电且支持SPP，并让手机等其它客户端断开；这些是排查方向，不代表已确定故障原因";

struct DeviceSearch(HBLUETOOTH_DEVICE_FIND);
impl Drop for DeviceSearch {
    fn drop(&mut self) {
        // 此保护对象唯一持有成功的FindFirst句柄。
        unsafe { BluetoothFindDeviceClose(self.0) };
    }
}

fn sdk_error(stage: &str, code: u32) -> String {
    format!("{stage}: Win32 {code} ({})", io::Error::from_raw_os_error(code as i32))
}

fn has_spp(info: &BLUETOOTH_DEVICE_INFO) -> Result<bool, String> {
    let address = format_address(unsafe { info.Address.Anonymous.ullLong });
    let stage = format!("BluetoothEnumerateInstalledServices({address})");
    let mut count = 0;
    // 只读已安装服务，不搜索、配对或安装服务。
    let result = unsafe {
        BluetoothEnumerateInstalledServices(null_mut(), info, &mut count, null_mut())
    };
    if result != ERROR_SUCCESS && result != ERROR_MORE_DATA {
        return Err(sdk_error(&stage, result));
    }
    if count == 0 {
        if result != ERROR_SUCCESS {
            return Err(sdk_error(&stage, result));
        }
        return Ok(false);
    }
    let mut services = vec![GUID::default(); count as usize];
    let result = unsafe {
        BluetoothEnumerateInstalledServices(null_mut(), info, &mut count, services.as_mut_ptr())
    };
    if result != ERROR_SUCCESS {
        return Err(sdk_error(&stage, result));
    }
    if count as usize > services.len() {
        return Err(format!("{stage}: SDK返回的服务数量超过缓冲区"));
    }
    Ok(services[..count as usize].iter().any(|guid| {
        guid.data1 == SPP.data1 && guid.data2 == SPP.data2
            && guid.data3 == SPP.data3 && guid.data4 == SPP.data4
    }))
}

fn enumerate_devices(wanted: Option<u64>) -> Result<Vec<BluetoothDevice>, String> {
    let params = BLUETOOTH_DEVICE_SEARCH_PARAMS {
        dwSize: size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
        fReturnAuthenticated: 1,
        fReturnRemembered: 0,
        fReturnUnknown: 0,
        fReturnConnected: 0,
        fIssueInquiry: 0,
        cTimeoutMultiplier: 0,
        hRadio: null_mut(),
    };
    let new_info = || BLUETOOTH_DEVICE_INFO {
        dwSize: size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
        ..Default::default()
    };
    let mut info = new_info();
    let handle = unsafe { BluetoothFindFirstDevice(&params, &mut info) };
    if handle.is_null() {
        let code = unsafe { GetLastError() };
        return if code == ERROR_NO_MORE_ITEMS {
            Ok(Vec::new())
        } else {
            Err(sdk_error("BluetoothFindFirstDevice（仅读取已配对缓存）", code))
        };
    }
    let search = DeviceSearch(handle);
    let mut devices = Vec::new();
    loop {
        let address = unsafe { info.Address.Anonymous.ullLong };
        if info.fAuthenticated != 0 && wanted.is_none_or(|wanted| wanted == address) && has_spp(&info)? {
            let length = info.szName.iter().position(|&unit| unit == 0).unwrap_or(info.szName.len());
            devices.push(BluetoothDevice {
                address: format_address(address),
                name: String::from_utf16_lossy(&info.szName[..length]),
                connected: info.fConnected != 0,
            });
        }
        info = new_info();
        if unsafe { BluetoothFindNextDevice(search.0, &mut info) } == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_NO_MORE_ITEMS {
                return Err(sdk_error("BluetoothFindNextDevice", code));
            }
            break;
        }
    }
    devices.sort_by(|left, right| left.address.cmp(&right.address));
    devices.dedup_by(|next, previous| {
        if next.address == previous.address {
            previous.connected |= next.connected;
            true
        } else {
            false
        }
    });
    Ok(devices)
}

pub(crate) fn list_devices() -> Result<Vec<BluetoothDevice>, String> {
    enumerate_devices(None).map_err(|error| format!("{error}。{CONNECTION_HINT}"))
}

fn wsa_error(stage: &str, code: i32) -> io::Error {
    let system = io::Error::from_raw_os_error(code);
    let kind = match code {
        ws::WSAEWOULDBLOCK => ErrorKind::WouldBlock,
        ws::WSAEINTR => ErrorKind::Interrupted,
        ws::WSAETIMEDOUT => ErrorKind::TimedOut,
        _ => system.kind(),
    };
    io::Error::new(kind, format!("{stage}: WSA {code} ({system})"))
}

fn last_wsa_error(stage: &str) -> io::Error {
    // 清理或其他SDK调用可能覆盖线程错误，先取出原生WSA码。
    wsa_error(stage, unsafe { ws::WSAGetLastError() })
}

struct Winsock;
impl Winsock {
    fn start() -> io::Result<Self> {
        let mut data = ws::WSADATA::default();
        let code = unsafe { ws::WSAStartup(0x0202, &mut data) };
        if code != 0 {
            return Err(wsa_error("WSAStartup(2.2)", code));
        }
        let startup = Self;
        if data.wVersion != 0x0202 {
            return Err(io::Error::new(ErrorKind::Unsupported, format!(
                "WSAStartup: 请求2.2但返回版本0x{:04X}", data.wVersion
            )));
        }
        Ok(startup)
    }
}
impl Drop for Winsock {
    fn drop(&mut self) {
        unsafe { ws::WSACleanup() };
    }
}

// 所有生产套接字均非阻塞；先关闭socket，再释放所属WSAStartup引用。
// 连接失败或取消也走同一生命周期。
struct Socket {
    raw: ws::SOCKET,
    _winsock: Winsock,
}
impl Drop for Socket {
    fn drop(&mut self) {
        unsafe { ws::closesocket(self.raw) };
    }
}
impl Socket {
    fn rfcomm(deadline: Instant, cancelled: &AtomicBool) -> Result<Self, String> {
        check_open(deadline, cancelled, "WSAStartup前")?;
        let winsock = Winsock::start().map_err(|error| error.to_string())?;
        check_open(deadline, cancelled, "socket(AF_BTH)前")?;
        let raw = unsafe { ws::socket(AF_BTH as i32, ws::SOCK_STREAM, BTHPROTO_RFCOMM as i32) };
        if raw == ws::INVALID_SOCKET {
            return Err(last_wsa_error("socket(AF_BTH, RFCOMM)").to_string());
        }
        let socket = Self { raw, _winsock: winsock };
        check_open(deadline, cancelled, "ioctlsocket前")?;
        socket.nonblocking().map_err(|error| error.to_string())?;
        Ok(socket)
    }

    fn nonblocking(&self) -> io::Result<()> {
        let mut enabled = 1;
        if unsafe { ws::ioctlsocket(self.raw, ws::FIONBIO, &mut enabled) } == ws::SOCKET_ERROR {
            return Err(last_wsa_error("ioctlsocket(FIONBIO)"));
        }
        Ok(())
    }

    fn pending_error(&self, stage: &str) -> io::Result<()> {
        let mut code = 0i32;
        let mut length = size_of::<i32>() as i32;
        if unsafe {
            ws::getsockopt(self.raw, ws::SOL_SOCKET, ws::SO_ERROR, (&mut code as *mut i32).cast(), &mut length)
        } == ws::SOCKET_ERROR {
            return Err(last_wsa_error(stage));
        }
        if code != 0 {
            return Err(wsa_error(stage, code));
        }
        Ok(())
    }

    fn wait_writable(&self, duration: Duration, stage: &str) -> io::Result<bool> {
        let mut writable = ws::FD_SET::default();
        writable.fd_count = 1;
        writable.fd_array[0] = self.raw;
        let mut exceptional = writable;
        let timeout = ws::TIMEVAL {
            tv_sec: duration.as_secs().min(i32::MAX as u64) as i32,
            tv_usec: duration.subsec_micros() as i32,
        };
        let result = unsafe {
            ws::select(0, null_mut(), &mut writable, &mut exceptional, &timeout)
        };
        if result == ws::SOCKET_ERROR {
            return Err(last_wsa_error(stage));
        }
        if exceptional.fd_count != 0 {
            self.pending_error(stage)?;
            return Err(io::Error::new(ErrorKind::Other, format!(
                "{stage}: select报告异常但SO_ERROR为0"
            )));
        }
        Ok(result != 0 && writable.fd_count != 0)
    }

    fn read_available(&self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        let count = unsafe {
            ws::recv(self.raw, bytes.as_mut_ptr(), bytes.len().min(i32::MAX as usize) as i32, 0)
        };
        if count == ws::SOCKET_ERROR {
            Err(last_wsa_error("RFCOMM recv"))
        } else {
            // 非空缓冲区收到成功的零字节读取才代表对端EOF。
            Ok(count as usize)
        }
    }

    fn write_frame(&self, bytes: &[u8], timeout: Duration) -> io::Result<()> {
        let deadline = deadline(timeout, "RFCOMM write_frame")?;
        let mut written = 0;
        while written < bytes.len() {
            let remaining = deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero())
                .ok_or_else(|| write_timeout(written, bytes.len()))?;
            let count = unsafe {
                ws::send(self.raw, bytes[written..].as_ptr(), (bytes.len() - written).min(i32::MAX as usize) as i32, 0)
            };
            if count > 0 {
                written += count as usize;
                if Instant::now() >= deadline {
                    return Err(write_timeout(written, bytes.len()));
                }
                continue;
            }
            if count == 0 {
                return Err(io::Error::new(ErrorKind::WriteZero, format!(
                    "RFCOMM send: 写入0字节（已发送{written}/{}；不得重发整帧）", bytes.len()
                )));
            }
            let error = last_wsa_error("RFCOMM send");
            match error.kind() {
                ErrorKind::WouldBlock => {
                    // 每次send/select后都从同一个绝对截止时刻重算剩余时间。
                    let wait = deadline.checked_duration_since(Instant::now())
                        .unwrap_or(Duration::ZERO).min(remaining);
                    if wait.is_zero() {
                        return Err(write_timeout(written, bytes.len()));
                    }
                    match self.wait_writable(wait, "RFCOMM write select") {
                        Ok(_) => {}
                        Err(error) if error.kind() == ErrorKind::Interrupted => {}
                        Err(error) => return Err(write_failure(error, written, bytes.len())),
                    }
                }
                ErrorKind::Interrupted => {}
                _ => return Err(write_failure(error, written, bytes.len())),
            }
        }
        Ok(())
    }
}

fn deadline(timeout: Duration, stage: &str) -> io::Result<Instant> {
    Instant::now().checked_add(timeout).ok_or_else(|| {
        io::Error::new(ErrorKind::InvalidInput, format!("{stage}: timeout超出时钟范围"))
    })
}

fn write_timeout(written: usize, total: usize) -> io::Error {
    io::Error::new(ErrorKind::TimedOut, format!(
        "RFCOMM write_frame: 全帧总deadline到期（已发送{written}/{total}；不得重发整帧）"
    ))
}

fn write_failure(error: io::Error, written: usize, total: usize) -> io::Error {
    io::Error::new(error.kind(), format!(
        "{error}（已发送{written}/{total}；不得重发整帧）"
    ))
}

fn check_open(deadline: Instant, cancelled: &AtomicBool, stage: &str) -> Result<Duration, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err(format!("蓝牙连接已取消（{stage}）"));
    }
    deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero())
        .ok_or_else(|| format!("蓝牙连接总deadline到期（{stage}）"))
}

// 缓存SDK没有取消参数，隔离缓存校验，避免系统调用延长连接总期限。
// 此线程不创建socket或发送数据，迟到结果丢弃，查找句柄由DeviceSearch释放。
// 不后台重试或自动重连。
fn validate_endpoint(address: u64, deadline: Instant, cancelled: &AtomicBool) -> Result<(), String> {
    check_open(deadline, cancelled, "检查已配对SPP缓存前")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new().name("bluetooth-spp-cache".into()).spawn(move || {
        let result = enumerate_devices(Some(address)).and_then(|devices| {
            if devices.is_empty() {
                Err(format!("{}不是Windows已配对且已确认SPP服务的端点", format_address(address)))
            } else {
                Ok(())
            }
        });
        let _ = sender.send(result);
    }).map_err(|error| format!("启动已配对SPP缓存检查线程失败: {error}"))?;
    loop {
        let remaining = check_open(deadline, cancelled, "读取已配对SPP缓存")?;
        match receiver.recv_timeout(remaining.min(CANCEL_SLICE)) {
            Ok(result) => {
                check_open(deadline, cancelled, "完成已配对SPP缓存检查")?;
                return result;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err("已配对SPP缓存检查线程异常退出".into()),
        }
    }
}

pub(crate) struct BluetoothStream {
    socket: Socket,
}
impl BluetoothStream {
    pub(crate) fn connect(address: &str, timeout: Duration, cancelled: &AtomicBool) -> Result<Self, String> {
        Self::connect_inner(address, timeout, cancelled)
            .map_err(|error| format!("{error}。{CONNECTION_HINT}"))
    }

    fn connect_inner(address: &str, timeout: Duration, cancelled: &AtomicBool) -> Result<Self, String> {
        let deadline = deadline(timeout, "BluetoothStream::connect").map_err(|e| e.to_string())?;
        check_open(deadline, cancelled, "连接开始")?;
        let address = parse_address(address)?;
        validate_endpoint(address, deadline, cancelled)?;
        check_open(deadline, cancelled, "创建RFCOMM socket前")?;
        let socket = Socket::rfcomm(deadline, cancelled)?;
        check_open(deadline, cancelled, "RFCOMM connect前")?;
        let endpoint = SOCKADDR_BTH {
            addressFamily: AF_BTH,
            btAddr: address,
            serviceClassId: SPP,
            // 由蓝牙provider按SPP UUID解析SDP，不猜测RFCOMM通道。
            port: 0,
        };
        let result = unsafe {
            ws::connect(socket.raw, (&endpoint as *const SOCKADDR_BTH).cast(), size_of::<SOCKADDR_BTH>() as i32)
        };
        if result == ws::SOCKET_ERROR {
            let code = unsafe { ws::WSAGetLastError() };
            if !matches!(code, ws::WSAEWOULDBLOCK | ws::WSAEINPROGRESS | ws::WSAEALREADY) {
                return Err(wsa_error("RFCOMM connect(SPP UUID/SDP)", code).to_string());
            }
            loop {
                let remaining = check_open(deadline, cancelled, "等待RFCOMM connect")?;
                match socket.wait_writable(remaining.min(CANCEL_SLICE), "RFCOMM connect select") {
                    Ok(true) => {
                        socket.pending_error("RFCOMM connect SO_ERROR").map_err(|e| e.to_string())?;
                        break;
                    }
                    Ok(false) => {}
                    Err(error) if error.kind() == ErrorKind::Interrupted => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
        check_open(deadline, cancelled, "RFCOMM connect完成")?;
        Ok(Self { socket })
    }

    pub(crate) fn read_available(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.socket.read_available(bytes)
    }

    pub(crate) fn write_frame(&mut self, bytes: &[u8], timeout: Duration) -> io::Result<()> {
        self.socket.write_frame(bytes, timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::os::windows::io::{AsRawSocket, IntoRawSocket};

    // 用本地TCP复用实际生产字节I/O和RAII；不枚举无线设备、不建立蓝牙连接，
    // 不将这些结果称为射频或SPP链路验证。
    fn tcp_pair() -> (BluetoothStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (stream, _) = listener.accept().unwrap();
        let winsock = Winsock::start().unwrap();
        let socket = Socket { raw: stream.into_raw_socket() as ws::SOCKET, _winsock: winsock };
        socket.nonblocking().unwrap();
        (BluetoothStream { socket }, peer)
    }

    fn buffer_size(socket: ws::SOCKET, option: i32, size: i32) {
        let result = unsafe {
            ws::setsockopt(socket, ws::SOL_SOCKET, option, (&size as *const i32).cast(), size_of::<i32>() as i32)
        };
        assert_eq!(result, 0, "{}", last_wsa_error("test setsockopt"));
    }

    fn read_eventually(stream: &mut BluetoothStream, bytes: &mut [u8]) -> usize {
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            match stream.read_available(bytes) {
                Ok(count) => return count,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    assert!(Instant::now() < until, "receive deadline expired");
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("{error}"),
            }
        }
    }

    #[test]
    fn nonblocking_read_distinguishes_no_data_partial_reads_and_eof() {
        let (mut stream, mut peer) = tcp_pair();
        let mut buffer = [0; 2];
        let error = stream.read_available(&mut buffer).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::WouldBlock);
        peer.write_all(&[1, 2, 3, 4, 5]).unwrap();
        peer.shutdown(Shutdown::Write).unwrap();
        let mut received = Vec::new();
        loop {
            let count = read_eventually(&mut stream, &mut buffer);
            if count == 0 { break; }
            assert!(count <= 2);
            received.extend_from_slice(&buffer[..count]);
        }
        assert_eq!(received, [1, 2, 3, 4, 5]);
    }

    #[test]
    fn complete_frame_survives_small_socket_buffer_without_duplication() {
        let (mut stream, mut peer) = tcp_pair();
        buffer_size(stream.socket.raw, ws::SO_SNDBUF, 1024);
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let payload: Vec<u8> = (0..256 * 1024).map(|index| (index % 251) as u8).collect();
        let reader = std::thread::spawn(move || {
            let mut received = Vec::new();
            peer.read_to_end(&mut received).unwrap();
            received
        });
        stream.write_frame(&payload, Duration::from_secs(2)).unwrap();
        drop(stream);
        assert_eq!(reader.join().unwrap(), payload);
    }

    #[test]
    fn blocked_peer_times_out_whole_frame_without_resetting_deadline() {
        let (mut stream, mut peer) = tcp_pair();
        buffer_size(stream.socket.raw, ws::SO_SNDBUF, 1024);
        buffer_size(peer.as_raw_socket() as ws::SOCKET, ws::SO_RCVBUF, 1024);
        // Windows回环可能吸收数MB而不立即阻塞，先观察到持续不可写再测超时。
        let fill = [0x5a; 64 * 1024];
        let fill_deadline = Instant::now() + Duration::from_secs(3);
        loop {
            assert!(Instant::now() < fill_deadline, "未能建立TCP背压");
            let count = unsafe { ws::send(stream.socket.raw, fill.as_ptr(), fill.len() as i32, 0) };
            if count == ws::SOCKET_ERROR {
                let error = last_wsa_error("test backpressure send");
                assert_eq!(error.kind(), ErrorKind::WouldBlock);
                if !stream.socket.wait_writable(Duration::from_millis(40), "test backpressure select").unwrap() {
                    break;
                }
            } else {
                assert!(count > 0);
            }
        }
        let payload = vec![0x5a; 8 * 1024 * 1024];
        let started = Instant::now();
        let error = stream.write_frame(&payload, Duration::from_millis(40)).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::TimedOut);
        // 只给出宽松调度容差，不作为硬实时性能测试。
        assert!(started.elapsed() < Duration::from_secs(2));
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut buffer = [0; 4096];
        let received = peer.read(&mut buffer).unwrap();
        assert!(received > 0 && received < payload.len());
        assert!(buffer[..received].iter().all(|&byte| byte == 0x5a));
    }

    #[test]
    fn zero_write_deadline_sends_nothing_and_drop_closes_socket() {
        let (mut stream, mut peer) = tcp_pair();
        assert_eq!(stream.write_frame(&[0x55], Duration::ZERO).unwrap_err().kind(), ErrorKind::TimedOut);
        drop(stream);
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        assert_eq!(peer.read(&mut [0; 1]).unwrap(), 0);
    }

}
