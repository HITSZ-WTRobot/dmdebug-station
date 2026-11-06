import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_MAP, Opcode, decodeFrame, encodeRequest, type DeviceDefinition } from '../src/lib/protocol';
import { ProtocolDemo } from '../src/lib/demo';
import { confirmParameter, exportTuningFile, finiteF32, parseTuningFile, sameF32, tuningFields, updateSnapshotParameter, validateSnapshot, type OzoneParameter, type OzoneSnapshot } from '../src/lib/tuning';

const linear = DEVICE_MAP.get(0x0a)!, joint = DEVICE_MAP.get(0x0d)!, m2006 = DEVICE_MAP.get(0x21)!;
function snapshotFor(definition: DeviceDefinition): OzoneSnapshot {
  return { deviceId: definition.id, parameters: tuningFields(definition).map((field, index) => {
    const mirrored = definition.kind === 'm2006' ? field.key.startsWith('velocity_') : index >= 5;
    return { key: field.key, label: field.label, unit: field.unit, expression: `fixed.${field.key}`, address: 0x24000000 + index * 8, value: Math.fround(index + 0.25),
      mirrors: mirrored ? [{ expression: `mirror.${field.key}`, address: 0x24001000 + index * 8, value: Math.fround(index + 0.25) }] : [] };
  }) };
}
function fileFor(definition: DeviceDefinition) {
  return { format: 'dmdebug-ozone-tuning', version: 1, deviceId: definition.id, kind: definition.kind,
    values: Object.fromEntries(tuningFields(definition).map(field => [field.key, -1.25])) };
}
function written(parameter: OzoneParameter, value: number): OzoneParameter {
  return { ...parameter, value: Math.fround(value), mirrors: parameter.mirrors.map(mirror => ({ ...mirror, value: Math.fround(value) })) };
}

test('固定八设备目录只使用内部单位，伸缩无 min/max，M2006 仅速度六字段', () => {
  assert.equal(tuningFields(linear).length, 8);
  assert.equal(tuningFields(joint).length, 10);
  assert.deepEqual(tuningFields(m2006).map(field => field.key), ['velocity_kp', 'velocity_ki', 'velocity_kd', 'velocity_output_max', 'max_rpm', 'stationary_rpm']);
  assert.ok(!tuningFields(linear).some(field => field.key === 'min_deg' || field.key === 'max_deg'));
  assert.equal(tuningFields(linear).find(field => field.key === 'finish_deg')!.unit, 'deg');
  assert.throws(() => tuningFields(DEVICE_MAP.get(0x40)!));
  assert.throws(() => tuningFields({ ...linear, id: 0xff }));
  assert.throws(() => tuningFields({ ...linear, kind: 'joint' }));
});

test('仅验证有限 float32，不增加物理参数范围或正数门禁', () => {
  for (const value of [0, -0, -9999, 1e30, 0.1]) assert.equal(finiteF32(value), true);
  for (const value of [NaN, Infinity, -Infinity, 1e100, '1', null]) assert.equal(finiteF32(value), false);
  const file = parseTuningFile(JSON.stringify(fileFor(m2006)), m2006);
  assert.ok(Object.values(file.values).every(value => value === -1.25));
  assert.equal(sameF32(0.1, Math.fround(0.1)), true);
  assert.equal(sameF32(0, -0), false);
});

test('参数文件按单设备 id/kind/固定 keys 严格匹配，不接受旧 schema 或表达式', () => {
  const file = fileFor(linear);
  const invalid = [
    { ...file, format: 'dmdebug-tuning' }, { ...file, version: 2 }, { ...file, deviceId: 0x0b }, { ...file, kind: 'joint' },
    { ...file, address: 0x24000000 }, { ...file, values: { ...file.values, arbitrary: 1 } },
    { ...file, values: Object.fromEntries(Object.entries(file.values).slice(1)) },
    { ...file, values: { ...file.values, kp: '3' } }, { ...file, values: { ...file.values, kp: null } },
    { ...file, values: { ...file.values, kp: 1e100 } }, { ...file, values: [] },
  ];
  for (const candidate of invalid) assert.throws(() => parseTuningFile(JSON.stringify(candidate), linear));
  assert.throws(() => parseTuningFile('[]', linear));
  assert.throws(() => parseTuningFile('{bad json', linear));
  const speedFile = fileFor(m2006);
  for (const key of ['position_kp', 'profile_max_spd', 'finish_deg']) {
    assert.throws(() => parseTuningFile(JSON.stringify({ ...speedFile, values: { ...speedFile.values, [key]: 1 } }), m2006));
  }
});

test('导入只产生独立草稿值，不修改当前快照；导出仅包含实际回读', () => {
  const snapshot = snapshotFor(joint), original = structuredClone(snapshot);
  const imported = parseTuningFile(JSON.stringify(fileFor(joint)), joint);
  const draft = { ...imported.values, kp: 999 };
  const exported = parseTuningFile(exportTuningFile(joint, snapshot), joint);
  assert.equal(draft.kp, 999);
  assert.equal(exported.values.kp, snapshot.parameters.find(parameter => parameter.key === 'kp')!.value);
  assert.notEqual(exported.values.kp, draft.kp);
  assert.deepEqual(snapshot, original);
  assert.throws(() => exportTuningFile(joint, null));
  assert.throws(() => exportTuningFile(linear, snapshot));
});

test('快照拒绝错误设备、缺字段、重复 key、错误镜像与无效地址', () => {
  const snapshot = snapshotFor(m2006);
  assert.doesNotThrow(() => validateSnapshot(snapshot, m2006));
  const invalid = [
    { ...snapshot, deviceId: 0x22 },
    { ...snapshot, parameters: snapshot.parameters.slice(1) },
    { ...snapshot, parameters: snapshot.parameters.map((parameter, index) => index === 1 ? snapshot.parameters[0] : parameter) },
    { ...snapshot, parameters: snapshot.parameters.map((parameter, index) => index === 0 ? { ...parameter, address: 3 } : parameter) },
    { ...snapshot, parameters: snapshot.parameters.map((parameter, index) => index === 0 ? { ...parameter, mirrors: [] } : parameter) },
    { ...snapshot, parameters: snapshot.parameters.map((parameter, index) => index === 0 ? { ...parameter, value: Infinity } : parameter) },
    { ...snapshot, parameters: snapshot.parameters.map(parameter => parameter.key === 'max_rpm' ? { ...parameter, mirrors: [{ expression: 'old.mirror', address: 0x24002000, value: 300 }] } : parameter) },
  ];
  for (const candidate of invalid) assert.throws(() => validateSnapshot(candidate, m2006));
});

test('单字段确认按 key 和精确 float32 bits，包含全部配置镜像', () => {
  const parameter = snapshotFor(m2006).parameters[0], value = 0.1;
  const result = written(parameter, value);
  assert.doesNotThrow(() => confirmParameter(result, m2006, parameter.key, value));
  assert.throws(() => confirmParameter(result, m2006, 'velocity_ki', value));
  assert.throws(() => confirmParameter(result, m2006, parameter.key, 0.10001));
  assert.throws(() => confirmParameter({ ...result, mirrors: result.mirrors.map(mirror => ({ ...mirror, value: 42 })) }, m2006, parameter.key, value));
  assert.throws(() => confirmParameter(written(parameter, -0), m2006, parameter.key, 0));
});

test('成功只更新对应行 current，其他行和原快照不变；失败不更新可见值', () => {
  const snapshot = snapshotFor(linear), before = structuredClone(snapshot);
  const field = snapshot.parameters.find(parameter => parameter.key === 'max_velocity_deg_s')!;
  const result = written(field, -12.5);
  const next = updateSnapshotParameter(snapshot, linear, field.key, -12.5, result);
  assert.deepEqual(snapshot, before);
  assert.equal(next.parameters.find(parameter => parameter.key === field.key), result);
  assert.equal(next.parameters.find(parameter => parameter.key === 'kp'), snapshot.parameters.find(parameter => parameter.key === 'kp'));
  assert.throws(() => updateSnapshotParameter(snapshot, linear, field.key, 123, result));
  assert.deepEqual(snapshot, before);
});

test('协议演示不分派 0x27，也不把直接内存写入伪装为串口成功', () => {
  const demo = new ProtocolDemo();
  assert.equal('SetControl' in Opcode, false);
  const before = decodeFrame(demo.handle(encodeRequest(1, Opcode.Parameters, linear.id))[0]);
  const rejected = decodeFrame(demo.handle(encodeRequest(2, 0x27, linear.id, [1, 2, 3, 4, 5]))[0]);
  const after = decodeFrame(demo.handle(encodeRequest(3, Opcode.Parameters, linear.id))[0]);
  assert.notEqual(rejected?.result, 0);
  assert.equal(before?.type, 'dm-parameters');
  assert.equal(after?.type, 'dm-parameters');
  if (before?.type === 'dm-parameters' && after?.type === 'dm-parameters') {
    assert.equal(after.kp, before.kp); assert.equal(after.finish, before.finish);
  }
});

test('匹配PMAX125的演示接受正负200mm，拒绝235mm且保留原目标', () => {
  for (const target of [200, -200]) {
    const demo = new ProtocolDemo();
    const enabled = decodeFrame(demo.handle(encodeRequest(1, Opcode.Enable, linear.id))[0]);
    assert.equal(enabled.result, 0);
    const rejected = decodeFrame(demo.handle(encodeRequest(2, Opcode.Move, linear.id, [235 * Math.sign(target)]))[0]);
    assert.equal(rejected.result, 6);
    const unchanged = decodeFrame(demo.handle(encodeRequest(3, Opcode.State, linear.id))[0]);
    assert.equal(unchanged.type, 'motor-state');
    if (unchanged.type === 'motor-state') assert.equal(unchanged.target, 0);
    const accepted = decodeFrame(demo.handle(encodeRequest(4, Opcode.Move, linear.id, [target]))[0]);
    assert.equal(accepted.result, 0);
    const moving = decodeFrame(demo.handle(encodeRequest(5, Opcode.State, linear.id))[0]);
    assert.equal(moving.type, 'motor-state');
    if (moving.type === 'motor-state') { assert.equal(moving.target, target); assert.equal(moving.flags.busy, true); }
  }
});
