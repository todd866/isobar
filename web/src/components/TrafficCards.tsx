import { clockParts, zoneAbbreviation } from '@/lib/time-label';
import { flightLevelLabel, type TrafficAircraft, type TrafficTrail } from '@/lib/traffic';
import { sampleTrafficAtTime, type FlightRoute, type TrafficSelection } from '@/lib/traffic-paths';
import { trackColor } from '@/lib/traffic-path-render';

export function TrafficCards({ selected, trails, routes, zone, nowMs, replayMs, onRemove }: {
  selected: readonly TrafficSelection[]; trails: ReadonlyMap<string, TrafficTrail>; routes: ReadonlyMap<string, FlightRoute | null>;
  zone: string; nowMs: number; replayMs?: number; onRemove: (aircraft: TrafficAircraft) => void;
}) {
  const time = (stamp: number) => clockParts(stamp, zone).time;
  const abbrev = zoneAbbreviation(nowMs, zone);
  return <div className="traffic-selection" aria-label="Tracked aircraft">
    <div className="traffic-chips" aria-label="Selected aircraft">
      {selected.map((item) => {
        const aircraft = trails.get(item.hex)?.aircraft;
        return aircraft ? <button key={item.hex} type="button" aria-label={`Remove ${aircraft.callsign}`} onClick={() => onRemove(aircraft)} style={{ '--track-light': trackColor(item.colorIndex, false), '--track-dark': trackColor(item.colorIndex, true) } as React.CSSProperties}>
          <span className="traffic-swatch" />{aircraft.callsign}<span aria-hidden="true">×</span>
        </button> : null;
      })}
    </div>
    <div className="traffic-cards" tabIndex={0} aria-label="Aircraft details">
      {selected.map((item) => {
        const trail = trails.get(item.hex); if (!trail) return null;
        const sample = replayMs == null ? trail.aircraft : sampleTrafficAtTime(trail, replayMs);
        const a = sample ?? { ...trail.aircraft, pressureAltitudeFt: NaN, groundSpeedKt: undefined, verticalRateFtMin: undefined, squawk: undefined };
        const route = replayMs == null ? routes.get(a.callsign) : null;
        const trend = a.verticalRateFtMin == null ? '' : a.verticalRateFtMin > 100 ? ' ↑' : a.verticalRateFtMin < -100 ? ' ↓' : ' →';
        const first = trail.points[0], last = trail.points.at(-1);
        return <article key={item.hex} data-traffic-card={item.hex} style={{ '--track-light': trackColor(item.colorIndex, false), '--track-dark': trackColor(item.colorIndex, true) } as React.CSSProperties}>
          <div><strong>{a.callsign}</strong><span>{a.type || '—'} · {a.registration || '—'}</span></div>
          <div><span>{route ? `${route.origin.name || route.origin.icao} → ${route.destination.name || route.destination.icao}` : 'Route —'}</span></div>
          <div><span title="Pressure altitude · vertical trend">{flightLevelLabel(a.pressureAltitudeFt)}{trend}</span><span>{a.groundSpeedKt == null ? '— kt' : `${Math.round(a.groundSpeedKt)} kt`}{a.squawk ? ` · SQ ${a.squawk}` : ''}</span></div>
          <div className="traffic-span" title={`Observed session track · ${zone} · line width encodes pressure altitude; dashed route is direct to destination, not a flight plan`}>
            <span>{first && last ? `${trail.points.length > 1 ? 'PAST' : 'OBS'} ${time(first.timeMs)}–${time(last.timeMs)} ${abbrev}` : 'PAST —'}</span><span>{replayMs != null ? (sample ? 'Replay' : 'No recorded position') : `${Math.max(0, Math.round((nowMs - a.positionTimeMs) / 1000))} s ago`}</span>
          </div>
        </article>;
      })}
    </div>
  </div>;
}
