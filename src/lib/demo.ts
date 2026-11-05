// Explicitly selected protocol demonstration, never a hardware fallback or a motor-physics claim.
import { DEVICES, Opcode, calcCrc16, type BodyVelocity, type DeviceDefinition } from './protocol';
interface DemoDevice { definition: DeviceDefinition; position: number; target: number; origin: number; enabled: boolean; busy: boolean; complete: boolean; fault: boolean; lastResult: number; count: number; body: BodyVelocity; limits: number[] }
export class ProtocolDemo {
  private devices = new Map<number, DemoDevice>();
  private previousTime = performance.now();
  private lastRequest = performance.now();
  private timeout = false;
  private cached: Uint8Array | null = null;
  private replies: Uint8Array[] = [];
  constructor() {
    for (const definition of DEVICES) this.devices.set(definition.id, { definition, position: 0, target: 0, origin: 0,
      enabled: false, busy: false, complete: false, fault: false, lastResult: 0, count: 50, body: { vx: 0, vy: 0, wz: 0 },
      limits: definition.kind === 'linear' ? [6.283333, 12.566667, 62.833333] : [-180, 180, 10, 20, 100] });
  }
  private response(request: Uint8Array, id: number, result: number, length = 2, write?: (view: DataView, bytes: Uint8Array) => void): Uint8Array {
    const bytes = new Uint8Array(64), view = new DataView(bytes.buffer);
    bytes.set([0xa5, 0x5a, 2, 1, request[4], request[5], request[6], id]);
    view.setUint16(8, length, true); view.setUint16(12, result, true); write?.(view, bytes);
    view.setUint16(62, calcCrc16(bytes, 62), true); return bytes;
  }
  handle(request: Uint8Array): Uint8Array[] {
    const now = performance.now(), dt = Math.min((now - this.previousTime) / 1000, 1); this.previousTime = now;
    if (now - this.lastRequest >= 500) { this.timeout = true; for (const m of this.devices.values()) { m.enabled = m.busy = false; m.fault = true; m.lastResult = 107; m.body = { vx: 0, vy: 0, wz: 0 }; } }
    for (const m of this.devices.values()) {
      m.count = (m.count + Math.max(1, Math.round(dt * 500))) >>> 0;
      if (m.busy) { const distance = m.target - m.position; const speed = m.definition.kind === 'linear' ? m.limits[0] : m.definition.kind === 'm2006' ? 60 : m.limits[2];
        m.position += Math.sign(distance) * Math.min(Math.abs(distance), dt * speed);
        if (Math.abs(m.position - m.target) < 0.0001) { m.position = m.target; m.busy = false; m.complete = true; } }
    }
    if (this.cached && request[4] === this.cached[4] && request[5] === this.cached[5]) {
      if (request.some((v, i) => v !== this.cached![i])) return [this.response(request, request[7], 106)];
      if (!this.timeout) this.lastRequest = now;
      return this.replies.map(r => r.slice());
    }
    const opcode = request[6], id = request[7]; const view = new DataView(request.buffer, request.byteOffset, 64);
    if (request[2] !== 2) return [this.response(request, id, 100)];
    if (opcode === Opcode.Heartbeat) this.timeout = false;
    if (!this.timeout) this.lastRequest = now;
    let responses: Uint8Array[];
    if (opcode === Opcode.Heartbeat || opcode === Opcode.Info) {
      responses = [this.response(request, 255, 0, opcode === Opcode.Info ? 42 : 8, (v, b) => {
        v.setUint16(14, 1 | (this.timeout ? 2 : 0), true); v.setUint32(16, Math.floor(now), true);
        if (opcode === Opcode.Info) { v.setUint16(20, 500, true); b[22] = 9; b[23] = 2;
          DEVICES.forEach((d, i) => { b[24 + i] = d.id; b[33 + i] = d.wireKind; });
          [100, 500, 1000, 500].forEach((value, i) => v.setUint16(42 + i * 2, value, true)); v.setUint32(50, 115200, true); }
      })];
    } else if (opcode === Opcode.Wheels && id === 0x40) {
      const m = this.devices.get(0x40)!, a = m.body;
      const tangents = [a.vx + a.vy, -a.vx + a.vy, -a.vx - a.vy, a.vx - a.vy];
      responses = [0x0b, 0x0a, 0x09, 0x0c].map((canId, i) => this.response(request, 0x41 + i, 0, 20, (v, b) => {
        v.setUint16(14, 1, true); b[16] = canId; b[17] = 0x20 + canId; v.setUint16(18, m.enabled ? 1 : 0, true);
        const rpm = m.enabled ? (tangents[i] / Math.SQRT2 + Math.hypot(0.2175, 0.2175) * a.wz * Math.PI / 180) / 0.0635 * 60 / (2 * Math.PI) : 0;
        v.setFloat32(24, rpm, true);
      }));
    } else {
      const ids = id === 255 ? DEVICES.map(d => d.id) : [id];
      responses = ids.map(deviceId => {
        const m = this.devices.get(deviceId); if (!m) return this.response(request, deviceId, 105);
        if (opcode === Opcode.State) return this.state(request, m);
        if (opcode === Opcode.Parameters) return this.parameters(request, m);
        let result = 0;
        if (this.timeout && (opcode === Opcode.Enable || opcode === Opcode.Move || opcode === Opcode.BodyVelocity)) result = 107;
        else if (opcode === Opcode.Enable) {
          if (m.definition.kind === 'm2006' && m.fault) result = m.lastResult;
          else { m.enabled = true; m.fault = false; m.complete = false; m.target = m.position; }
        } else if (opcode === Opcode.Disable) { m.enabled = m.busy = m.complete = false; m.body = { vx: 0, vy: 0, wz: 0 }; if (m.definition.kind === 'm2006' && m.fault) result = m.lastResult; }
        else if (opcode === Opcode.Stop) { if (!m.enabled) result = 3; else { m.busy = m.complete = false; m.target = m.position; m.body = { vx: 0, vy: 0, wz: 0 }; } }
        else if (opcode === Opcode.SetZero) {
          if (m.enabled) result = 4; else { m.origin += m.position; m.position = m.target = 0; m.fault = false; m.complete = false; if (m.definition.kind === 'joint') m.limits.splice(0, 2, -180, 180); }
        } else if (opcode === Opcode.Move) {
          const target = view.getFloat32(12, true);
          if (!m.enabled) result = 3; else if (m.busy) result = 4;
          else if (!Number.isFinite(target) || (m.definition.kind === 'linear' && Math.abs(target + m.origin) > 125 / 19.203 * 226.2 / (2 * Math.PI)) ||
            (m.definition.kind === 'joint' && (target < m.limits[0] || target > m.limits[1])) ||
            (m.definition.kind === 'm2006' && (target < 0 || target > 360))) result = 6;
          else { m.target = target; m.busy = true; m.complete = false; }
        } else if (opcode === Opcode.BodyVelocity && m.definition.kind === 'chassis') {
          const body = { vx: view.getFloat32(12, true), vy: view.getFloat32(16, true), wz: view.getFloat32(20, true) };
          if (!m.enabled) result = 3; else if (Math.abs(body.vx) > 0.100001 || Math.abs(body.vy) > 0.100001 || Math.abs(body.wz) > 10 || Object.values(body).some(n => !Number.isFinite(n))) result = 6; else m.body = body;
        } else if (opcode === Opcode.SetLimits) {
          const values = Array.from({ length: m.definition.kind === 'linear' ? 3 : 5 }, (_, i) => view.getFloat32(12 + i * 4, true));
          if (m.enabled) result = 4;
          else if (values.some(n => !Number.isFinite(n)) || values.slice(-3).some(n => n <= 0) || (values.length === 5 && (values[0] < -180 || values[1] > 180 || values[0] >= values[1]))) result = 5;
          else m.limits = values;
        } else result = 10;
        if (!m.fault || result !== 0) m.lastResult = result;
        return this.response(request, deviceId, result);
      });
    }
    this.cached = request.slice(); this.replies = responses.map(r => r.slice()); return responses;
  }
  private state(request: Uint8Array, m: DemoDevice): Uint8Array {
    const d = m.definition, length = d.kind === 'chassis' ? 44 : d.kind === 'm2006' ? 32 : 48;
    return this.response(request, d.id, 0, length, (v, b) => {
      v.setUint16(14, 1 | (d.kind !== 'chassis' ? 2 : 0) | (d.bus === 1 ? 4 : 0) | (m.enabled ? 8 : 0) | (m.busy ? 32 : 0) | (m.complete ? 64 : 0) | (m.fault ? 128 : 0) | (this.timeout ? 256 : 0), true);
      b[16] = d.wireKind; b[17] = d.unit === 'mm' ? 2 : d.unit === 'deg' ? 1 : 3; b[18] = d.bus;
      v.setUint16(20, m.lastResult, true); v.setUint16(22, d.bus === 1 ? (m.enabled ? 1 : 0) : 0xffff, true); v.setUint32(24, d.kind === 'chassis' ? 0 : m.count, true);
      if (d.kind === 'chassis') { [m.body.vx, m.body.vy, m.body.wz, m.body.vx, m.body.vy, m.body.wz].forEach((n, i) => v.setFloat32(28 + i * 4, n, true)); b[52] = 15; b[53] = m.enabled ? 15 : 0; return; }
      const speed = m.busy ? Math.sign(m.target - m.position) * (d.kind === 'linear' ? m.limits[0] : d.kind === 'm2006' ? 60 : m.limits[2]) : 0;
      v.setFloat32(28, m.position, true); v.setFloat32(32, speed, true); v.setFloat32(36, m.target, true);
      if (d.kind === 'm2006') v.setFloat32(40, speed / 6, true);
      else { v.setFloat32(40, m.position, true); v.setFloat32(44, speed, true); }
    });
  }
  private parameters(request: Uint8Array, m: DemoDevice): Uint8Array {
    const d = m.definition;
    return this.response(request, d.id, 0, d.kind === 'm2006' ? 50 : d.kind === 'chassis' ? 30 : 48, (v, b) => {
      let values: number[], offset: number;
      if (d.kind === 'm2006') { values = [9, .1, 0, 8000, 5, 4000, 400, 1800, 1200, 3000, .5, .1]; offset = 14; }
      else if (d.kind === 'chassis') { values = [.1, .1, 10, 30, 63.5, 435, 435]; offset = 14; }
      else { v.setUint16(14, d.kind === 'linear' ? 1 : 3, true); b[16] = d.wireKind; b[17] = d.kind === 'linear' ? 2 : 1; b[18] = 1;
        values = [...(d.kind === 'linear' ? [NaN, NaN, ...m.limits] : m.limits), 5, .5, 0, d.kind === 'linear' ? .1885 : .3, d.kind === 'linear' ? 1.1 : .1]; offset = 20; }
      values.forEach((n, i) => v.setFloat32(offset + i * 4, n, true));
    });
  }
}
