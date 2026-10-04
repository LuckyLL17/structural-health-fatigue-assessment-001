export type Reading = { sensorId: string; timeMs: number; value: number; unit: string; quality: 'good' | 'suspect' | 'bad' };
export type Alert = {
  id: string;
  sensorId: string;
  elementId: string;
  timeMs: number;
  severity: 'critical' | 'warning';
  value: number;
  threshold: number;
  status: 'open' | 'acknowledged' | 'closed';
  reason: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
};
export type Sensor = { id: string; name: string; type: 'strain' | 'acceleration' | 'displacement' | 'tilt' | 'temperature'; elementId: string; coordinate: { x: number; y: number; z: number }; unit: string; limits: { warning: number; critical: number }; status: 'online' | 'degraded' | 'offline' };
