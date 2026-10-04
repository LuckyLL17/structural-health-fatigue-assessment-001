import type { FastifyInstance } from 'fastify';
import { alerts, now, readings, sensors } from '../domain/state.js';
import type { Reading } from '../domain/types.js';
import { ingestReading } from '../services/readings.js';

const QUALITIES = ['good', 'suspect', 'bad'] as const;

export async function registerReadingRoutes(app: FastifyInstance) {
  app.post('/api/readings', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.sensorId || b.timeMs == null || b.value == null) {
      return res.code(400).send({ error: 'sensorId、timeMs、value 必填' });
    }
    const sensor = sensors.find((x) => x.id === b.sensorId);
    if (!sensor) return res.code(404).send({ error: 'sensor not found' });

    const timeMs = Number(b.timeMs);
    const value = Number(b.value);
    if (!Number.isFinite(timeMs) || !Number.isFinite(value)) {
      return res.code(400).send({ error: 'timeMs、value 必须是有限数值' });
    }
    const quality = b.quality || 'good';
    if (!QUALITIES.includes(quality)) {
      return res.code(400).send({ error: `quality 只能是 ${QUALITIES.join('/')}` });
    }
    const reading: Reading = { sensorId: sensor.id, timeMs, value, unit: b.unit || sensor.unit, quality };

    const result = ingestReading(sensor, reading);

    if (result.outcome === 'conflict') {
      return res.code(409).send({
        error: 'reading conflict at same sample time: stored reading is not overwritten',
        existing: result.existing,
        attempted: result.attempted,
        conflicts: result.conflicts,
      });
    }

    return res.code(200).send({
      accepted: result.outcome === 'accepted',
      idempotent: result.idempotent,
      outcome: result.outcome,
      reading: result.reading,
      alerts: result.alerts,
    });
  });

  app.get('/api/readings/replay', async (req: any) => {
    const q = req.query as any;
    const from = Number(q.from || 0), to = Number(q.to || Date.now());
    return {
      from,
      to,
      items: readings.filter((x) => x.timeMs >= from && x.timeMs <= to).sort((a, b) => a.timeMs - b.timeMs),
      timeUnit: 'epoch-milliseconds',
    };
  });

  app.post('/api/alerts/:id/ack', async (req: any, res: any) => {
    const a = alerts.find((x) => x.id === (req.params as any).id);
    if (!a) return res.code(404).send({ error: 'alert not found' });
    a.status = 'acknowledged';
    a.acknowledgedBy = (req.body as any)?.operator || 'structural-engineer';
    a.acknowledgedAt = now();
    return a;
  });
}
