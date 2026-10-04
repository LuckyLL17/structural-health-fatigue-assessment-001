import { alerts, fatigueRuns, sensors } from '../domain/state.js';

// 同一传感器同一采样时刻最多产生一条告警，按 (sensorId,timeMs) 去重，
// 防止任何重复告警行导致健康分被重复扣减
function countOpenBySeverity(severity: string) {
  const seen = new Set<string>();
  for (const a of alerts) {
    if (a.severity === severity && a.status !== 'closed') {
      seen.add(`${a.sensorId}@${a.timeMs}`);
    }
  }
  return seen.size;
}

export function healthIndex() {
  const critical = countOpenBySeverity('critical');
  const warning = countOpenBySeverity('warning');
  const offline = sensors.filter(x => x.status === 'offline').length;
  const fatigue = fatigueRuns.reduce((s, x) => s + x.damage, 0);
  return Number(Math.max(0, 100 - critical * 28 - warning * 9 - offline * 6 - fatigue * 30).toFixed(2));
}
