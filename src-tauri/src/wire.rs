// 协议 v2 字节契约；只在完整校验后交给事务状态机。
pub const IDS: [u8; 9] = [0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x21, 0x22, 0x40];
pub const KINDS: [u8; 9] = [1, 1, 1, 2, 1, 2, 3, 3, 4];
pub const HEARTBEAT: u8 = 1;
pub const INFO: u8 = 2;
pub const STATE: u8 = 0x10;
pub const PARAMETERS: u8 = 0x11;
pub const WHEELS: u8 = 0x12;
pub const ENABLE: u8 = 0x20;
pub const DISABLE: u8 = 0x21;
pub const STOP: u8 = 0x22;
pub const ZERO: u8 = 0x23;
pub const MOVE: u8 = 0x24;
pub const LIMITS: u8 = 0x25;
pub const VELOCITY: u8 = 0x26;
pub type Frame = [u8; 64];
pub fn u16_at(b: &[u8], p: usize) -> u16 { u16::from_le_bytes([b[p], b[p + 1]]) }
pub fn float(b: &[u8], p: usize) -> f32 { f32::from_le_bytes(b[p..p + 4].try_into().unwrap()) }
pub fn put_u16(b: &mut [u8], p: usize, v: u16) { b[p..p + 2].copy_from_slice(&v.to_le_bytes()); }
pub fn put_u32(b: &mut [u8], p: usize, v: u32) { b[p..p + 4].copy_from_slice(&v.to_le_bytes()); }
pub fn put_float(b: &mut [u8], p: usize, v: f32) { b[p..p + 4].copy_from_slice(&v.to_le_bytes()); }
pub fn crc(b: &[u8]) -> u16 {
    let mut value = 0xffffu16;
    for byte in b { value ^= (*byte as u16) << 8; for _ in 0..8 { value = if value & 0x8000 != 0 { (value << 1) ^ 0x1021 } else { value << 1 }; } }
    value
}
pub fn seal(b: &mut Frame) { let value = crc(&b[..62]); put_u16(b, 62, value); }
pub fn request(seq: u16, op: u8, id: u8, values: &[f32]) -> Result<Frame, String> {
    if values.len() > 12 || values.iter().any(|v| !v.is_finite()) { return Err("请求必须包含有限 float32 数值".into()); }
    let mut b = [0; 64]; b[..4].copy_from_slice(&[0xa5, 0x5a, 2, 0]); put_u16(&mut b, 4, seq); b[6] = op; b[7] = id;
    put_u16(&mut b, 8, (values.len() * 4) as u16);
    for (i, value) in values.iter().enumerate() { put_float(&mut b, 12 + 4 * i, *value); }
    seal(&mut b); Ok(b)
}
pub fn expected(op: u8, id: u8) -> Vec<u8> {
    if id == 255 && matches!(op, STATE | DISABLE | STOP) { IDS.to_vec() }
    else if op == WHEELS && id == 0x40 { vec![0x41, 0x42, 0x43, 0x44] } else { vec![id] }
}
pub fn definition(id: u8) -> Option<(u8, u8, u8)> {
    IDS.iter().position(|v| *v == id).map(|i| { let kind = KINDS[i]; (kind, if kind == 1 { 2 } else if kind == 4 { 3 } else { 1 }, if kind <= 2 { 1 } else if kind == 3 { 3 } else { 2 }) })
}
#[derive(Debug, PartialEq)]
pub enum Issue { Crc, Version, Structure }
pub fn validate(b: &Frame) -> Result<(), Issue> {
    if b[..2] != [0xa5, 0x5a] { return Err(Issue::Structure); }
    if u16_at(b, 62) != crc(&b[..62]) { return Err(Issue::Crc); }
    if b[2] != 2 { return Err(Issue::Version); }
    let n = u16_at(b, 8) as usize;
    if b[3] != 1 || !(2..=50).contains(&n) || u16_at(b, 10) != 0 || b[12 + n..62].iter().any(|v| *v != 0) { return Err(Issue::Structure); }
    if u16_at(b, 12) != 0 { return if n == 2 { Ok(()) } else { Err(Issue::Structure) }; }
    let exact = |v| if n == v { Ok(()) } else { Err(Issue::Structure) };
    let finite = |positions: &[usize]| if positions.iter().all(|p| float(b, *p).is_finite()) { Ok(()) } else { Err(Issue::Structure) };
    match b[6] {
        HEARTBEAT => { exact(8)?; if b[7] != 255 { return Err(Issue::Structure); } }
        INFO => {
            exact(42)?;
            if b[7] != 255 || b[22] != 9 || b[23] != 2 || b[24..33] != IDS || b[33..42] != KINDS { return Err(Issue::Structure); }
        }
        WHEELS => { exact(20)?; if !(0x41..=0x44).contains(&b[7]) { return Err(Issue::Structure); } finite(&[20, 24, 28])?; }
        op => {
            let (kind, unit, bus) = definition(b[7]).ok_or(Issue::Structure)?;
            if op == STATE {
                if b[16..20] != [kind, unit, bus, 0] { return Err(Issue::Structure); }
                if kind == 4 { exact(44)?; finite(&[28, 32, 36, 40, 44, 48])?; }
                else if kind == 3 { exact(32)?; finite(&[28, 32, 36, 40])?; }
                else { exact(48)?; finite(&[28, 32, 36, 40, 44, 48, 52])?; }
            } else if op == PARAMETERS {
                if kind == 3 { exact(50)?; finite(&[14, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54, 58])?; }
                else if kind == 4 { exact(30)?; finite(&[14, 18, 22, 26, 30, 34, 38])?; }
                else {
                    exact(48)?;
                    if b[16..19] != [kind, unit, 1] { return Err(Issue::Structure); }
                    if kind == 1 { if !float(b, 20).is_nan() || !float(b, 24).is_nan() { return Err(Issue::Structure); } }
                    else { finite(&[20, 24])?; }
                    finite(&[28, 32, 36, 40, 44, 48, 52, 56])?;
                }
            } else { exact(2)?; }
        }
    }
    Ok(())
}
#[derive(Default)]
pub struct Stream { pending: Vec<u8> }
impl Stream {
    pub fn feed(&mut self, bytes: &[u8]) -> (Vec<Frame>, Vec<Issue>) {
        self.pending.extend_from_slice(bytes);
        let mut frames = Vec::new(); let mut issues = Vec::new(); let mut at = 0;
        while at + 1 < self.pending.len() {
            if self.pending[at..at + 2] != [0xa5, 0x5a] { at += 1; continue; }
            if self.pending.len() - at < 64 { break; }
            let raw: Frame = self.pending[at..at + 64].try_into().unwrap();
            match validate(&raw) { Ok(()) => { frames.push(raw); at += 64; }, Err(Issue::Crc) => { issues.push(Issue::Crc); at += 1; }, Err(issue) => { issues.push(issue); at += 64; } }
        }
        self.pending.drain(..at);
        if self.pending.len() == 1 && self.pending[0] != 0xa5 { self.pending.clear(); }
        (frames, issues)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crc_vector_and_noise_resynchronization() {
        assert_eq!(crc(b"123456789"), 0x29b1);
        let mut good = request(7, DISABLE, 0x0a, &[]).unwrap(); good[3] = 1; put_u16(&mut good, 8, 2); seal(&mut good);
        let mut bad = good; bad[21] ^= 1;
        let mut stream = Stream::default();
        assert!(stream.feed(&[0x03, 0xa5]).0.is_empty());
        let mut data = bad.to_vec(); data.extend_from_slice(&good[..31]);
        let (frames, issues) = stream.feed(&data); assert!(frames.is_empty()); assert_eq!(issues, vec![Issue::Crc]);
        assert_eq!(stream.feed(&good[31..]).0, vec![good]);
    }
    #[test]
    fn error_two_bytes_and_padding_are_checked() {
        let mut b = request(1, STATE, 255, &[]).unwrap(); b[3] = 1; put_u16(&mut b, 8, 2); put_u16(&mut b, 12, 105); seal(&mut b);
        assert_eq!(validate(&b), Ok(())); b[14] = 1; seal(&mut b); assert_eq!(validate(&b), Err(Issue::Structure));
    }
}

#[cfg(test)]
mod golden_vectors {
    use super::*;
    #[test]
    fn protocol_document_independent_crc_vectors() {
        // SERIAL_PROTOCOL.md 第 11/12 节，预期值来自独立 binascii.crc_hqx，非本模块生成。
        for (seq,op,id,values,checksum) in [
            (1,HEARTBEAT,255,vec![],[0xb7,0xd6]),
            (2,STATE,255,vec![],[0x5f,0x62]),
            (3,MOVE,0x0a,vec![2.],[0x0b,0x78]),
            (4,MOVE,0x0d,vec![30.],[0x2a,0x3b]),
            (5,MOVE,0x21,vec![90.],[0xbc,0x15]),
            (6,VELOCITY,0x40,vec![0.05,0.,0.],[0xe7,0x41]),
            (7,WHEELS,0x40,vec![],[0x5a,0xf4]),
            (8,DISABLE,255,vec![],[0x3d,0x02]),
        ] {
            let b=request(seq,op,id,&values).unwrap();assert_eq!(b[62..64],checksum);
            assert_eq!(b[..4],[0xa5,0x5a,2,0]);assert_eq!(u16_at(&b,8),values.len() as u16*4);assert!(b[12+values.len()*4..62].iter().all(|v|*v==0));
        }
        // 文档的 linear_target 成功应答：固定原始字节与 D4 DA 校验尾，不调用 seal。
        let mut ack=[0u8;64];ack[..10].copy_from_slice(&[0xa5,0x5a,2,1,3,0,0x24,0x0a,2,0]);ack[62..].copy_from_slice(&[0xd4,0xda]);
        assert_eq!(validate(&ack),Ok(()));
    }
}
