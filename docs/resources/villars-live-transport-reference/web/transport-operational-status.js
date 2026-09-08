import { argentinaNow, normalizeStationName, serviceDays } from './transport-services.js';

function activeBySchedule(service, minutes) {
  const times = (service?.stops || []).map(({ minutes: value }) => value).filter(Number.isFinite);
  return times.length >= 2 && minutes >= Math.min(...times) && minutes <= Math.max(...times);
}

export function operationalStatusForService(snapshot, route, dayKey, service, timezone, date = new Date(), rank = null) {
  const now = argentinaNow(timezone, date);
  const isToday = dayKey === serviceDays[now.weekday];
  const record = isToday && route?.type === 'train'
    ? (snapshot?.services || []).find((candidate) => (
      candidate?.provider === 'sofse'
      && candidate?.lineKey === route.lineKey
      && String(candidate?.serviceNumber) === String(service?.name)
      && candidate?.operationalDate === now.date
      && (!candidate?.destination || normalizeStationName(candidate.destination) === normalizeStationName(service?.destination))
    ))
    : null;

  if (record?.status === 'cancelled') return { state: 'cancelled', label: 'Cancelado', record };
  if (record?.status === 'delayed') {
    const minutes = Number(record.delayMinutes);
    return {
      state: 'delayed',
      label: Number.isFinite(minutes) && minutes > 0 ? `Demorado +${minutes} min` : 'Demorado',
      record,
    };
  }
  if (record?.status === 'in_progress') return { state: 'in-progress', label: 'En curso', record };
  if (record?.status === 'confirmed') return { state: 'confirmed', label: 'Confirmado', record };
  if (record?.status === 'completed') return { state: 'completed', label: 'Finalizado', record };
  if (isToday && activeBySchedule(service, now.minutes)) return { state: 'scheduled-active', label: 'En curso estimado', record };
  if (rank === 0) return { state: 'scheduled', label: 'Programado', record };
  return record?.status === 'scheduled' ? { state: 'scheduled', label: 'Programado', record } : null;
}
