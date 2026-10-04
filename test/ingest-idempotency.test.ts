import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { alerts, audits, readings } from '../src/domain/state.js';

const app = await buildApp();

// 进程内状态复位，保证本文件可独立重复运行
readings.length = 0;
alerts.length = 0;
audits.length = 0;

async function postReadings(body: any) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/readings',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() };
}

const T1 = 1_700_000_000_000;
const T2 = T1 + 60_000;
const T3 = T1 + 120_000;

test('首次提交：写入读数、生成一条 critical 告警和一条审计，健康分扣分', async () => {
  const r = await postReadings({ sensorId: 'S-G1-STR', timeMs: T1, value: 1500 });
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted, true);
  assert.equal(r.body.duplicate, false);
  assert.equal(readings.length, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');
  assert.equal(alerts[0].status, 'open');
  assert.equal(r.body.alerts.length, 1);
  assert.deepEqual(audits.map(x => x.action), ['reading.ingest']);
});

test('完全相同的重试：幂等返回，读数/告警/审计均不重复，健康分不变', async () => {
  const beforeAlertId = alerts[0].id;
  const r = await postReadings({ sensorId: 'S-G1-STR', timeMs: T1, value: 1500, unit: 'microstrain', quality: 'good' });
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted, true);
  assert.equal(r.body.duplicate, true, '应标记为重复重试');
  assert.equal(readings.length, 1, '读数不得重复写入');
  assert.equal(alerts.length, 1, '告警不得重复生成');
  assert.equal(r.body.alerts[0].id, beforeAlertId, '必须回放首次生成的同一告警');
  assert.deepEqual(audits.map(x => x.action), ['reading.ingest'], '重试不得再写审计');
});

test('同传感器同时间但 value/unit/quality 不同：409 冲突，不覆盖、不告警、重复冲突每次留痕', async () => {
  const conflicts = [
    { value: 1200 }, // 数值不同（本会落入 warning 区间，也不得产生新告警）
    { value: 1500, unit: 'ue' }, // 单位不同
    { value: 1500, unit: 'microstrain', quality: 'bad' }, // 质量不同
  ];
  for (const override of conflicts) {
    const r = await postReadings({ sensorId: 'S-G1-STR', timeMs: T1, unit: 'microstrain', quality: 'good', ...override });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'reading conflict');
    assert.equal(r.body.existing.value, 1500, '原读数数值不得被覆盖');
    assert.equal(r.body.existing.unit, 'microstrain');
    assert.equal(r.body.existing.quality, 'good');
  }
  assert.equal(readings.length, 1, '冲突提交不得新增读数');
  assert.equal(alerts.length, 1, '冲突提交不得新增或改写告警');
  assert.equal(readings[0].value, 1500, '原数据保持不变');
  assert.deepEqual(audits.map(x => x.action), ['reading.ingest', 'reading.conflict', 'reading.conflict', 'reading.conflict']);
});

test('不同传感器同一采样时刻：各自独立接收与告警', async () => {
  const r = await postReadings({ sensorId: 'S-P2-DIS', timeMs: T1, value: 40 });
  assert.equal(r.status, 200);
  assert.equal(r.body.duplicate, false);
  assert.equal(readings.length, 2);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].sensorId, 'S-P2-DIS');
  assert.equal(alerts[1].severity, 'critical');
});

test('同一传感器不同采样时刻：独立接收，warning 告警独立扣分', async () => {
  const r = await postReadings({ sensorId: 'S-G1-STR', timeMs: T2, value: 950 });
  assert.equal(r.status, 200);
  assert.equal(readings.length, 3);
  assert.equal(alerts.length, 3);
  assert.equal(alerts[2].severity, 'warning');

  // 立即重试同样幂等
  const retry = await postReadings({ sensorId: 'S-G1-STR', timeMs: T2, value: 950 });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(readings.length, 3);
  assert.equal(alerts.length, 3);
});

test('低于阈值读数的重复提交幂等；其冲突提交也不得补造告警', async () => {
  const r = await postReadings({ sensorId: 'S-G1-ACC', timeMs: T3, value: 0.05 });
  assert.equal(r.status, 200);
  assert.equal(alerts.length, 3, '低于阈值不产生告警');
  const retry = await postReadings({ sensorId: 'S-G1-ACC', timeMs: T3, value: 0.05 });
  assert.equal(retry.body.duplicate, true);
  assert.equal(alerts.length, 3);
  const conflict = await postReadings({ sensorId: 'S-G1-ACC', timeMs: T3, value: 0.3 });
  assert.equal(conflict.status, 409);
  assert.equal(alerts.length, 3, '冲突数值即使越阈值也不得补造告警');
  assert.equal(readings.length, 4);
});

test('replay 只返回去重后的真实读数', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/readings/replay?from=0&to=${T3 + 1}` });
  const body = res.json();
  assert.equal(body.items.length, 4);
  assert.deepEqual(body.items.map((x: any) => `${x.sensorId}@${x.timeMs}`), [
    `S-G1-STR@${T1}`,
    `S-P2-DIS@${T1}`,
    `S-G1-STR@${T2}`,
    `S-G1-ACC@${T3}`,
  ]);
});

test('告警确认行为保留：确认与重复确认只改变同一条告警', async () => {
  const id = alerts[0].id;
  const ack1 = await app.inject({ method: 'POST', url: `/api/alerts/${id}/ack`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ operator: 'lao-wang' }) });
  assert.equal(ack1.statusCode, 200);
  assert.equal(ack1.json().status, 'acknowledged');
  assert.equal(ack1.json().acknowledgedBy, 'lao-wang');
  const ack2 = await app.inject({ method: 'POST', url: `/api/alerts/${id}/ack`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({}) });
  assert.equal(ack2.statusCode, 200);
  assert.equal(alerts.length, 3);
  assert.equal(alerts.filter(x => x.id === id).length, 1);
});

test('健康摘要：指数按去重告警计算（2 critical + 1 warning = 35），openAlerts 与审计计数正确', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health/summary' });
  const s = res.json();
  assert.equal(s.healthIndex, 35, `期望 100 - 2*28 - 9 = 35，实际 ${s.healthIndex}`);
  assert.equal(s.openAlerts.length, 3, 'acknowledged 但未 closed 仍计入，保持原语义');

  const auditRes = await app.inject({ method: 'GET', url: '/api/audit' });
  const list = auditRes.json();
  assert.equal(list.length, 8, '4 条 ingest + 4 条 conflict，重试与确认不产生重复审计');
  assert.deepEqual(list.map((x: any) => x.action).sort(), [
    'reading.conflict', 'reading.conflict', 'reading.conflict', 'reading.conflict',
    'reading.ingest', 'reading.ingest', 'reading.ingest', 'reading.ingest',
  ]);
});

test.after(async () => { await app.close(); });
