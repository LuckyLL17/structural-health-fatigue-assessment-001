import { newId } from '../core/id.js';
import type { FastifyInstance } from 'fastify';
import { alerts, log, now, readings, sensors } from '../domain/state.js';
import type { Reading } from '../domain/types.js';

const QUALITIES = ['good', 'suspect', 'bad'] as const;

function sameReading(a: Reading, b: Reading) {
  // (sensorId, timeMs) 已由调用方确认相同；完全相同的重试必须逐字段一致
  return a.value === b.value && a.unit === b.unit && a.quality === b.quality;
}

export async function registerReadingRoutes(app: FastifyInstance) {
  app.post('/api/readings', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.sensorId || b.timeMs == null || b.value == null) {
      return res.code(400).send({ error: 'sensorId、timeMs、value 必填' });
    }
    const sensor = sensors.find(x => x.id === b.sensorId);
    if (!sensor) return res.code(404).send({ error: 'sensor not found' });

    const timeMs = Number(b.timeMs);
    const value = Number(b.value);
    if (!Number.isFinite(timeMs) || !Number.isFinite(value)) {
      return res.code(400).send({ error: 'timeMs、value 必须是有限数值' });
    }
    const quality = b.quality || 'good';
    if (!QUALITIES.includes(quality)) {
      return res.code(400).send({ error: `quality 必须是 ${QUALITIES.join('/')}` });
    }
    const reading: Reading = { sensorId: sensor.id, timeMs, value, unit: b.unit || sensor.unit, quality };

    // (sensorId, timeMs) 是采样点的唯一标识：采集网关超时重试不会产生新采样
    const existing = readings.find(x => x.sensorId === reading.sensorId && x.timeMs === reading.timeMs);
    if (existing) {
      if (sameReading(existing, reading)) {
        // 幂等重试：不重复写读数、告警、健康扣分或审计，直接回放首次结果
        return res.send({
          accepted: true,
          duplicate: true,
          reading: existing,
          alerts: alerts.filter(x => x.sensorId === sensor.id && x.timeMs === reading.timeMs),
        });
      }
      // 同一采样时刻但数值/单位/质量不同：明确冲突，拒绝并留痕，绝不覆盖原读数
      log('reading.conflict', sensor.id, { attempted: reading, existing });
      return res.code(409).send({
        error: 'reading conflict',
        message: '相同 sensorId + timeMs 已存在不同 value/unit/quality 的读数，原数据保持不变',
        existing,
        attempted: reading,
      });
    }

    readings.push(reading);
    const abs = Math.abs(reading.value);
    if (abs >= sensor.limits.critical) {
      alerts.push({ id: newId(), sensorId: sensor.id, elementId: sensor.elementId, timeMs: reading.timeMs, severity: 'critical', value: reading.value, threshold: sensor.limits.critical, status: 'open', reason: 'threshold-exceeded' });
    } else if (abs >= sensor.limits.warning) {
      alerts.push({ id: newId(), sensorId: sensor.id, elementId: sensor.elementId, timeMs: reading.timeMs, severity: 'warning', value: reading.value, threshold: sensor.limits.warning, status: 'open', reason: 'threshold-exceeded' });
    }
    log('reading.ingest', sensor.id, reading);
    return {
      accepted: true,
      duplicate: false,
      reading,
      alerts: alerts.filter(x => x.sensorId === sensor.id && x.timeMs === reading.timeMs),
    };
  });

  app.get('/api/readings/replay', async (req: any) => {
    const q = req.query as any;
    const from = Number(q.from || 0), to = Number(q.to || Date.now());
    return { from, to, items: readings.filter(x => x.timeMs >= from && x.timeMs <= to).sort((a, b) => a.timeMs - b.timeMs), timeUnit: 'epoch-milliseconds' };
  });

  app.post('/api/alerts/:id/ack', async (req: any, res: any) => {
    const a = alerts.find(x => x.id === (req.params as any).id);
    if (!a) return res.code(404).send({ error: 'alert not found' });
    // 重复确认与已确认后的再确认保持幂等：只更新确认人/时间，不产生新告警或新读数
    a.status = 'acknowledged';
    a.acknowledgedBy = (req.body as any)?.operator || 'structural-engineer';
    a.acknowledgedAt = now();
    return a;
  });
}
