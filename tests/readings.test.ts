import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { alerts, audits, fatigueRuns, inspections, modalRuns, readings } from '../src/domain/state.js';

let app: FastifyInstance;

before(async () => {
  app = await buildApp();
  app.log.level = 'silent';
});

after(async () => {
  await app.close();
});

beforeEach(() => {
  // State is held by the domain/state module; seed data (sensors/elements) stays.
  readings.length = 0;
  alerts.length = 0;
  audits.length = 0;
  modalRuns.length = 0;
  fatigueRuns.length = 0;
  inspections.length = 0;
});

async function postReading(body: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/api/readings', payload: body });
  return { status: res.statusCode, body: res.json() };
}

const STRAIN = 'S-G1-STR'; // warning >= 900, critical >= 1400 microstrain
const DISP = 'S-P2-DIS'; // warning >= 18 mm

test('首次提交：入库、产生一次告警、一条审计，健康摘要扣分一次', async () => {
  const timeMs = 1_700_000_001_000;
  const r = await postReading({ sensorId: STRAIN, timeMs, value: 1000, unit: 'microstrain', quality: 'good' });

  assert.equal(r.status, 200);
  assert.equal(r.body.accepted, true);
  assert.equal(r.body.idempotent, false);
  assert.equal(r.body.outcome, 'accepted');
  assert.equal(readings.length, 1);
  assert.equal(alerts.length, 1);
  assert.equal(r.body.alerts[0].severity, 'warning');
  assert.equal(r.body.alerts[0].status, 'open');

  const ingestAudits = audits.filter((a) => a.action === 'reading.ingest');
  assert.equal(ingestAudits.length, 1);

  const summary = await app.inject({ method: 'GET', url: '/api/health/summary' });
  const s = summary.json();
  assert.equal(s.openAlerts.length, 1);
  assert.equal(s.healthIndex, 91); // 100 - 9 (one open warning)
});

test('完全相同的重试幂等：不重复入库/告警/扣分/写审计，返回同一条告警', async () => {
  const timeMs = 1_700_000_002_000;
  const payload = { sensorId: STRAIN, timeMs, value: 1000, unit: 'microstrain', quality: 'good' };
  const first = await postReading(payload);
  const alertId = first.body.alerts[0].id;

  for (let i = 0; i < 3; i++) {
    const retry = await postReading(payload);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.accepted, false);
    assert.equal(retry.body.idempotent, true);
    assert.equal(retry.body.outcome, 'duplicate');
    assert.deepEqual(retry.body.reading, first.body.reading);
    assert.equal(retry.body.alerts.length, 1);
    assert.equal(retry.body.alerts[0].id, alertId);
  }

  assert.equal(readings.length, 1);
  assert.equal(alerts.length, 1);
  assert.equal(audits.filter((a) => a.action === 'reading.ingest').length, 1);

  const s = (await app.inject({ method: 'GET', url: '/api/health/summary' })).json();
  assert.equal(s.openAlerts.length, 1);
  assert.equal(s.healthIndex, 91);
});

test('相同采样时刻数值冲突：409 拒绝且不覆盖原数据，重试同一冲突不重复写审计', async () => {
  const timeMs = 1_700_000_003_000;
  await postReading({ sensorId: STRAIN, timeMs, value: 1000, quality: 'good' });

  const conflict = await postReading({ sensorId: STRAIN, timeMs, value: 1200, quality: 'good' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.includes('conflict'), true);
  assert.deepEqual(conflict.body.conflicts, [{ field: 'value', existing: 1000, attempted: 1200 }]);
  assert.equal(readings[0].value, 1000, '原读数不得被覆盖');

  // Retrying the same conflicting payload is itself idempotent in the audit trail.
  await postReading({ sensorId: STRAIN, timeMs, value: 1200, quality: 'good' });
  assert.equal(audits.filter((a) => a.action === 'reading.conflict-rejected').length, 1);

  assert.equal(readings.length, 1);
  assert.equal(alerts.length, 1);
  const s = (await app.inject({ method: 'GET', url: '/api/health/summary' })).json();
  assert.equal(s.healthIndex, 91, '冲突被拒绝，健康分保持首次提交结果');
});

test('相同采样时刻单位或质量冲突：逐项报告差异，保留原值', async () => {
  const timeMs = 1_700_000_004_000;
  await postReading({ sensorId: STRAIN, timeMs, value: 1000, unit: 'microstrain', quality: 'good' });

  const unitConflict = await postReading({ sensorId: STRAIN, timeMs, value: 1000, unit: 'ue', quality: 'good' });
  assert.equal(unitConflict.status, 409);
  assert.deepEqual(unitConflict.body.conflicts, [{ field: 'unit', existing: 'microstrain', attempted: 'ue' }]);

  const qualityConflict = await postReading({ sensorId: STRAIN, timeMs, value: 1000, unit: 'microstrain', quality: 'bad' });
  assert.equal(qualityConflict.status, 409);
  assert.deepEqual(qualityConflict.body.conflicts, [{ field: 'quality', existing: 'good', attempted: 'bad' }]);

  assert.deepEqual(readings[0], { sensorId: STRAIN, timeMs, value: 1000, unit: 'microstrain', quality: 'good' });
  assert.equal(alerts.length, 1);
  assert.equal(audits.filter((a) => a.action === 'reading.conflict-rejected').length, 2);
});

test('不同传感器、不同采样时刻各自独立，互不幂等影响', async () => {
  const t1 = 1_700_000_005_000;
  const t2 = 1_700_000_006_000;
  const a = await postReading({ sensorId: STRAIN, timeMs: t1, value: 1000 });
  const b = await postReading({ sensorId: DISP, timeMs: t1, value: 20 });
  const c = await postReading({ sensorId: STRAIN, timeMs: t2, value: 950 });
  assert.equal(a.body.accepted, true);
  assert.equal(b.body.accepted, true);
  assert.equal(c.body.accepted, true);
  assert.equal(readings.length, 3);
  assert.equal(alerts.length, 3);

  const dupB = await postReading({ sensorId: DISP, timeMs: t1, value: 20 });
  assert.equal(dupB.body.idempotent, true);
  assert.equal(readings.length, 3);
  assert.equal(alerts.length, 3);

  const s = (await app.inject({ method: 'GET', url: '/api/health/summary' })).json();
  assert.equal(s.openAlerts.length, 3);
  assert.equal(s.healthIndex, 73); // 100 - 3 * 9
});

test('告警确认在幂等重试后保留，确认行为不被重复提交破坏', async () => {
  const timeMs = 1_700_000_007_000;
  const first = await postReading({ sensorId: STRAIN, timeMs, value: 1000 });
  const alertId = first.body.alerts[0].id;

  const ack = await app.inject({
    method: 'POST',
    url: `/api/alerts/${alertId}/ack`,
    payload: { operator: 'operator-li' },
  });
  assert.equal(ack.statusCode, 200);
  assert.equal(ack.json().status, 'acknowledged');

  const retry = await postReading({ sensorId: STRAIN, timeMs, value: 1000 });
  assert.equal(retry.body.idempotent, true);
  const sameAlert = retry.body.alerts[0];
  assert.equal(sameAlert.id, alertId);
  assert.equal(sameAlert.status, 'acknowledged');
  assert.equal(sameAlert.acknowledgedBy, 'operator-li');
  assert.ok(sameAlert.acknowledgedAt);
  assert.equal(alerts.length, 1);

  // Acknowledged alerts remain open (not closed) and keep counting in the summary.
  const s = (await app.inject({ method: 'GET', url: '/api/health/summary' })).json();
  assert.equal(s.openAlerts.length, 1);
  assert.equal(s.openAlerts[0].status, 'acknowledged');
  assert.equal(s.healthIndex, 91);
});

test('低于阈值的读数不产生告警，重复提交仍然幂等', async () => {
  const timeMs = 1_700_000_008_000;
  const first = await postReading({ sensorId: STRAIN, timeMs, value: 100 });
  assert.equal(first.body.alerts.length, 0);
  const retry = await postReading({ sensorId: STRAIN, timeMs, value: 100 });
  assert.equal(retry.body.outcome, 'duplicate');
  assert.equal(retry.body.alerts.length, 0);
  assert.equal(readings.length, 1);
  assert.equal(alerts.length, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/health/summary' })).json().healthIndex, 100);
});

test('critical 读数：重复不重复扣分，冲突不改变已扣分数', async () => {
  const timeMs = 1_700_000_009_000;
  const payload = { sensorId: STRAIN, timeMs, value: 1500, unit: 'microstrain', quality: 'good' };
  const first = await postReading(payload);
  assert.equal(first.body.alerts[0].severity, 'critical');
  await postReading(payload);
  await postReading({ sensorId: STRAIN, timeMs, value: 1600 });
  const s = (await app.inject({ method: 'GET', url: '/api/health/summary' })).json();
  assert.equal(alerts.length, 1);
  assert.equal(s.healthIndex, 72); // 100 - 28 (one critical)
});

test('审计接口可查询入库与冲突拒绝记录', async () => {
  const timeMs = 1_700_000_010_000;
  await postReading({ sensorId: STRAIN, timeMs, value: 1000 });
  await postReading({ sensorId: STRAIN, timeMs, value: 1001 });

  const res = await app.inject({ method: 'GET', url: '/api/audit' });
  assert.equal(res.statusCode, 200);
  const actions = res.json().map((a: { action: string }) => a.action);
  assert.deepEqual(actions, ['reading.ingest', 'reading.conflict-rejected']);
});

test('非法输入返回 400，未知传感器返回 404，不产生副作用', async () => {
  const badNumber = await postReading({ sensorId: STRAIN, timeMs: 1_700_000_011_000, value: 'not-a-number' });
  assert.equal(badNumber.status, 400);
  const badQuality = await postReading({ sensorId: STRAIN, timeMs: 1_700_000_011_001, value: 1, quality: 'weird' });
  assert.equal(badQuality.status, 400);
  const unknown = await postReading({ sensorId: 'NOPE', timeMs: 1_700_000_011_002, value: 1 });
  assert.equal(unknown.status, 404);
  assert.equal(readings.length, 0);
  assert.equal(audits.length, 0);
});
