import { useState } from 'react';
import type { Dossier } from '@/lib/od/model';
import { DECREES, editionVariant } from '@/lib/od/decrees';
import { FLEET, TEACHING_LABEL } from '@/lib/od/manual';
import { usFdpHours } from '@/lib/od/checks';
import { forecastGroups, freezingLevelFt } from '@/lib/od/weather';
import { utc } from '@/lib/od/desk';

export const DOCUMENTS = [
  ['plan', 'Flight plan', '01'], ['taf', 'Destination TAF', '02'], ['metar', 'Departure METAR', '03'],
  ['log', 'Technical log', '04'], ['bulletin', 'Ministry bulletin', '05'], ['manual', 'Operations manual', '06'],
] as const;
export type DocumentId = typeof DOCUMENTS[number][0];
export function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return <dl className="od-rows">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
const yes = (value: boolean) => value ? 'Yes' : 'No';
const freezing = (value: number | null) => value === null ? 'Unknown' : String(Math.round(value));
const defects: Record<string, string> = { antiIce: 'Anti-ice', onePack: 'One pack', autopilot: 'Autopilot', apu: 'APU' };

export function DocumentContent({ id, dossier: d, emblemSrc }: { id: DocumentId; dossier: Dossier; emblemSrc: string }) {
  const plan = d.plan, docs = d.documents;
  if (id === 'manual') return <Manual dossier={d} emblemSrc={emblemSrc} />;
  if (id === 'plan') return <>
    <div className="od-letterhead"><span>REPUBLIC AIR TRANSPORT</span><span>OD / 01</span></div>
    <h2>Flight release</h2>
    <p className="od-route">{d.departure.name}<span aria-hidden="true"> ↓ </span>{d.destination.name}</p>
    <Rows rows={[
      ['Aircraft', FLEET[d.aircraft].name], ['Operation', `${d.operation} · ${plan.rules} · ${plan.night ? 'night' : 'day'}`],
      ['ETD · UTC', utc(plan.departureUtc)], ['ETA · UTC', <strong key="eta" data-testid="plan-eta">{utc(plan.arrivalUtc)}</strong>],
      ['Alternate', d.alternatives.find(a => a.aerodrome.id === plan.alternateId)?.aerodrome.name ?? 'None nominated'],
      ['Distance / cruise', `${plan.distanceNm} NM / FL${plan.cruiseLevel}`], ['Headwind', `${plan.headwindKt} kt`],
      ['Usable fuel', `${plan.fuelKg.toLocaleString()} kg`], ['Holding allocation', `${Math.round(plan.holdingMinutes)} min`],
      ['Departure runway', `${plan.departureRunway.id} · ${plan.departureRunway.headingTrueDeg}°T · ${plan.departureRunway.lengthM} m`],
      ['Arrival runway', `${plan.arrivalRunway.id} · ${plan.arrivalRunway.headingTrueDeg}°T · ${plan.arrivalRunway.lengthM} m`],
      ['Landing minima', `${plan.landingMinima.ceilingFt} ft / ${plan.landingMinima.visibilityM} m`],
      ['Alternate minima', `${plan.alternateMinima.ceilingFt} ft / ${plan.alternateMinima.visibilityM} m`],
    ]} />
    <details><summary>Load & runway worksheet</summary><Rows rows={[
      ['Dry operating mass', `${plan.dryOperatingKg} kg`], ['Passenger / baggage', `${docs.passengerManifest.passengerMassKg} / ${docs.passengerManifest.baggageKg} kg`],
      ['Take-off / landing flap', `${plan.takeoffFlap}° / ${plan.landingFlap}°`], ['Density altitude', `${Math.round(plan.plannedDensityAltitudeFt)} ft`],
      ['Aerodrome elevation · departure / arrival', `${d.departure.elevationFt} / ${d.destination.elevationFt} ft AMSL`],
      ['Departure surface', `${plan.departureRunway.state} · ${plan.departureRunway.contaminationMm} mm · inspected ${yes(plan.departureRunway.inspected)}`],
      ['Arrival surface', `${plan.arrivalRunway.state} · ${plan.arrivalRunway.contaminationMm} mm · inspected ${yes(plan.arrivalRunway.inspected)}`],
      ['Cloud exposure', yes(plan.cloudExposure)], ['Freezing level · departure / arrival', `${freezing(freezingLevelFt(d.departureWeather, Date.parse(plan.departureUtc)))} / ${freezing(freezingLevelFt(d.destinationWeather, Date.parse(plan.arrivalUtc)))} ft AMSL`], ['Instrument approach', yes(plan.instrumentApproach)],
      ['Cloud separation', `${plan.cloudClearance.aboveFt} ft above / ${plan.cloudClearance.belowFt} ft below / ${plan.cloudClearance.horizontalM} m horizontal`],
    ]} /></details>
    <details><summary>Offered alternates</summary>{d.alternatives.map(a => <section key={a.aerodrome.id}><h3>{a.aerodrome.name} · {a.aerodrome.station}</h3><p>{a.distanceNm} NM · elevation {a.aerodrome.elevationFt} ft AMSL · RWY {a.runway.id}, {a.runway.headingTrueDeg}°T, {a.runway.lengthM} m, {a.runway.state}, inspected {yes(a.runway.inspected)}. Minima {a.minima.ceilingFt} ft / {a.minima.visibilityM} m.</p><pre>{a.weather.taf?.raw ?? 'TAF unavailable'}</pre><pre>{a.weather.metar?.raw ?? 'METAR unavailable'}</pre></section>)}</details>
    <p className="od-footnote">Fictional flight plan · published weather retained verbatim</p>
  </>;
  if (id === 'taf' || id === 'metar') {
    const destination = id === 'taf', place = destination ? d.destination : d.departure;
    const weather = destination ? d.destinationWeather : d.departureWeather;
    return <>
      <div className="od-letterhead"><span>METEOROLOGICAL OFFICE</span><span>{destination ? 'FORECAST' : 'OBSERVATION'}</span></div>
      <h2>{place.name}</h2><p>{place.station} · {destination ? 'Destination TAF' : 'Departure METAR'}</p>
      <pre className="od-weather-code">{destination ? weather.taf?.raw ?? 'TAF unavailable' : weather.metar?.raw ?? 'METAR unavailable'}</pre>
      <Rows rows={destination ? [
        ['Issued · UTC', weather.taf ? utc(weather.taf.issue) : 'Unknown'],
        ['Valid from', weather.taf ? utc(weather.taf.from) : 'Unknown'],
        ['Valid until', weather.taf ? utc(weather.taf.to) : 'Unknown'], ['Planned arrival', utc(plan.arrivalUtc)],
      ] : [['Observed · UTC', weather.metar ? utc(weather.metar.time) : 'Unknown'], ['Planned departure', utc(plan.departureUtc)], ['Runway heading', `${plan.departureRunway.headingTrueDeg}° true`]]} />
      {destination && <div className="od-taf-periods">{forecastGroups(weather)?.map((g, i) => <section key={i}><h3>{g.marker || 'BASE'} <span>{utc(g.start)} – {utc(g.end)}</span></h3><pre>{g.body}</pre></section>)}</div>}
      {destination && <details><summary>Arrival performance observation</summary><pre>{weather.metar?.raw ?? 'METAR unavailable'}</pre><p>Observed {weather.metar ? utc(weather.metar.time) : 'Unknown'} · aerodrome elevation {place.elevationFt} ft AMSL. Use this observation for the teaching runway worksheet.</p></details>}
      <p className="od-footnote">Source: {weather.source} · captured {utc(weather.capturedAt)}. Station identifiers and weather are unchanged. Times refer to this dossier’s weather snapshot.</p>
      <a href={`/?icao=${place.station}&time=${encodeURIComponent(destination ? plan.arrivalUtc : plan.departureUtc)}`}>On the map ↗</a>
    </>;
  }
  if (id === 'log') return <>
    <div className="od-letterhead"><span>ENGINEERING DEPARTMENT</span><span>OD / 04</span></div><h2>Technical log</h2>
    <p>{FLEET[d.aircraft].name}</p>
    <Rows rows={[
      ['Deferred defects', docs.technicalLog.defects.map(item => `${defects[item]} inoperative`).join('; ') || 'None'],
      ['MEL authorised', yes(docs.technicalLog.melAuthorised)], ['Placarded', yes(docs.technicalLog.placarded)],
      ['Dispatch procedure', docs.technicalLog.dispatchProcedureComplete ? 'Complete' : 'Incomplete'],
      ['External power / air', `${yes(docs.technicalLog.externalPower)} / ${yes(docs.technicalLog.externalAir)}`],
      ['Release signed', yes(docs.maintenanceRelease.signed)], ['Release expires', utc(docs.maintenanceRelease.validUntil)],
      ['Airframe / inspection', `${docs.maintenanceRelease.airframeHours} / ${docs.maintenanceRelease.nextInspectionHours} h`],
      ['Endorsed defects', docs.maintenanceRelease.endorsedDefects.map(item => defects[item] ?? item).join(', ') || 'None'],
    ]} />
    <details><summary>Crew credentials & duty roster</summary>
      {docs.crew.map((c, i) => <section key={c.id}><h3>{i ? 'First officer' : 'Captain'} · {c.id}</h3><Rows rows={[
        ['Licence / ratings', `${c.licence} · ${c.aircraftRatings.join(', ')}`], ['Instrument rated', yes(c.instrumentRated)],
        ['Medical', `Class ${c.medical.class} · expires ${utc(c.medical.validUntil)}`], ['Flight review expires', utc(c.flightReviewValidUntil)],
      ]} /><p>Take-offs: {c.takeoffs.map(t => `${utc(t.at)} ${t.night ? 'night' : 'day'}`).join('; ')}</p><p>Landings: {c.landings.map(l => `${utc(l.at)} ${l.night ? 'night' : 'day'} ${l.fullStop ? 'full stop' : 'touch & go'}`).join('; ')}</p></section>)}
      <Rows rows={[
        ['Duty scheme', docs.duty.scheme], ['Start / end UTC', `${utc(docs.duty.startUtc)} / ${utc(docs.duty.endUtc)}`],
        ['Start local / sectors', `${docs.duty.startLocalHour}:00 / ${docs.duty.sectors}`], ['Acclimatised', yes(docs.duty.acclimatised)],
        ['Flight time', `${docs.duty.flightMinutes} min`], ['Prior rest / sleep', `${docs.duty.priorRestHours} / ${docs.duty.sleepOpportunityHours} h`],
        ['Free in last 168 h', `${docs.duty.freeHoursLast168} h`],
      ]} />
    </details>
    <details><summary>Passenger manifest</summary><p>{docs.passengerManifest.names.join(', ') || 'No passengers'}</p><p>{docs.passengerManifest.paid ? 'Paid carriage' : 'Unpaid carriage'} · {docs.passengerManifest.passengerMassKg} kg + {docs.passengerManifest.baggageKg} kg baggage</p></details>
  </>;
  return <>
    <div className="od-letterhead"><span>MINISTRY OF TRANSPORT</span><span>SHIFT {d.shift}</span></div><h2>Daily bulletin</h2>
    <p>Air Navigation Code · {d.edition.toUpperCase()} edition</p>
    {DECREES.filter(r => r.shiftIntroduced <= d.shift).map(r => { const v = editionVariant(r, d.edition); return <section key={r.id}>
      <h3>§{r.shiftIntroduced} · {r.title}</h3><p>{v.citation}</p>
      <p>{r.id === 'forecast-coverage' && <>Planning window: ETA −{String(v.parameters.beforeMinutes)} / +{String(v.parameters.afterMinutes)} min. The whole window must lie inside the TAF.</>}</p>
      <details><summary>Reason & decision tree</summary><p>{v.reason}</p><Rows rows={Object.entries(v.parameters).map(([key, value]) => [key.replace(/([A-Z])/g, ' $1'), String(value)])} />{r.id === 'duty' && <DutyLimits dossier={d} />}{v.decisionTree.map(node => <p key={node.id}>{node.question}<br />Yes → {node.yes.replaceAll('_', ' ')} · No → {node.no.replaceAll('_', ' ')}</p>)}</details>
    </section>; })}
    <h3>NOTAMs</h3>{docs.notams.length ? docs.notams.map(n => <p key={n.id}>{n.id} · {n.aerodromeId} · RWY {n.runwayId} {n.closed ? 'CLOSED' : 'OPEN'} · {utc(n.from)} – {utc(n.to)} · {n.acknowledged ? 'Acknowledged' : 'Not acknowledged'}</p>) : <p>No notices supplied for this exercise.</p>}
    <p className="od-footnote">The Code is a teaching simplification. Legal sources and scope accompany Ministry citations.</p>
  </>;
}

function DutyLimits({ dossier: d }: { dossier: Dossier }) {
  const roster = d.documents.duty;
  if (d.operation === 'private') return <p>Private scheme: no commercial duty-table claim.</p>;
  if (d.edition === 'aus') return <p>Appendix 1 teaching scope: acclimatised, home-base start from 07:00; finish by 01:00 next day. FDP ≤9 h when starting before 14:00, otherwise ≤8 h. Prior rest ≥12 h, sleep opportunity ≥8 h, free in the last 168 h ≥36 h. Other cumulative checks are stipulated complete.</p>;
  if (d.operation === 'charter') return <p>Part 135 teaching scope: duty ≤14 h; prior rest ≥10 h. Flight time ≤8 h single-pilot or ≤10 h with two pilots. Other cumulative checks are stipulated complete.</p>;
  return <p>Part 117 teaching scope: for this {roster.startLocalHour}:00 start and {roster.sectors} sectors, FDP ≤{usFdpHours(roster.startLocalHour, roster.sectors)} h. Flight time ≤9 h for starts 05:00–19:59, otherwise ≤8 h. Prior rest ≥10 h, sleep opportunity ≥8 h, free in the last 168 h ≥30 h. Acclimatised, unaugmented crew; no extensions.</p>;
}

function Manual({ dossier: d, emblemSrc }: { dossier: Dossier; emblemSrc: string }) {
  const [page, setPage] = useState(0);
  const sheet = FLEET[d.aircraft];
  return <div className={`od-manual ${page === 0 ? 'od-manual-cover' : ''}`}>
    {page === 0 ? <><img src={emblemSrc} alt="" width="96" height="96" /><h2>{d.aircraft === 'a727' ? '727' : sheet.name}<br />Operations Manual</h2><p>REPUBLIC AIR TRANSPORT</p><p>{TEACHING_LABEL}</p><button onClick={() => setPage(1)}>Open booklet →</button></> : <>
      <nav className="od-book-nav" aria-label="Manual pages"><button disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous manual page">←</button><span>{['Cover', 'Fuel & time', 'Performance', 'MEL'][page]} · {page}/3</span><button disabled={page === 3} onClick={() => setPage(page + 1)} aria-label="Next manual page">→</button></nav>
      <h2>{page === 1 ? 'Fuel & time' : page === 2 ? 'Dispatch performance' : 'Deferred equipment'}</h2><p className="od-footnote">{TEACHING_LABEL}</p>
      {page === 1 && <>
        <table><caption>Still-air trip</caption><thead><tr><th>NM</th><th>FL</th><th>min</th><th>kg</th></tr></thead><tbody>{sheet.tripRows.map(r => <tr key={`${r.distanceNm}-${r.cruiseLevel}`}><td>{r.distanceNm}</td><td>{r.cruiseLevel}</td><td>{r.timeMinutes}</td><td>{r.fuelKg}</td></tr>)}</tbody></table>
        <p>Interpolate within the table. Headwind: still-air speed = NM ÷ hours; multiply time and fuel by TAS ÷ (TAS − headwind).</p>
        <Rows rows={[["Taxi", `${sheet.taxiFuelKg} kg`], ['Holding / 30 min', `${sheet.holdingFuelPer30MinKg} kg`], ['Tank capacity', `${sheet.maxFuelKg} kg`]]} />
        <table><caption>Alternate · still air</caption><thead><tr><th>NM</th><th>min</th><th>kg</th></tr></thead><tbody>{sheet.alternateRows.map(r => <tr key={r.distanceNm}><td>{r.distanceNm}</td><td>{r.timeMinutes}</td><td>{r.fuelKg}</td></tr>)}</tbody></table>
        <p>Final reserve and contingency depend on operation and Code edition. See Ministry §7.</p>
        <p>{d.edition === 'aus' ? 'Final reserve at holding consumption: turbine 30 min; piston 45 min, except private day VFR 30 min. Contingency: turbine 5% of trip; commercial piston 10%; private piston none. Commercial contingency is at least 5 min holding. Airline without an alternate adds 15 min holding.' : 'Final reserve at still-air trip cruise consumption: 45 min, except non-airline day VFR 30 min. No contingency allowance in this teaching scope.'}</p>
        <p>Total usable fuel = taxi + trip + contingency + alternate + allocated holding + final reserve. Apply the plan headwind to trip and alternate fuel.</p>
      </>}
      {page === 2 && <>
        <Rows rows={[["Maximum take-off", `${sheet.maxTakeoffKg} kg`], ['Maximum landing', `${sheet.maxLandingKg} kg`], ['Seats · including crew', sheet.seats], ['Flap · T/O / landing', `${sheet.flaps.takeoff.join(', ')}° / ${sheet.flaps.landing.join(', ')}°`], ['Crosswind · dry / wet / contaminated', `${sheet.crosswindLimitsKt.dry} / ${sheet.crosswindLimitsKt.wet} / ${sheet.crosswindLimitsKt.contaminated} kt`]]} />
        {(['takeoff', 'landing'] as const).map(phase => <table key={phase}><caption>{phase === 'takeoff' ? 'Take-off' : 'Landing'} · dry, sea-level ISA</caption><thead><tr><th>Mass kg</th><th>Distance m</th></tr></thead><tbody>{sheet.runway[phase].map(r => <tr key={r.weightKg}><td>{r.weightKg}</td><td>{r.distanceM}</td></tr>)}</tbody></table>)}
        <p>Pressure altitude = elevation + (1013.25 − QNH) × 27 ft. ISA = 15 − pressure altitude ÷ 500. Density altitude = pressure altitude + 120 × (temperature − ISA).</p>
        <p>Take-off mass = dry operating mass + passengers + baggage + usable fuel. Landing mass = take-off mass − trip fuel. Use the destination observation for landing pressure and temperature.</p>
        <p>Interpolate by mass, then multiply: (1 + pressure altitude ÷ 10,000) × (1 + max(0, temperature − 15) ÷ 100). Lower listed flap ×1.08; wet ×1.15; contaminated ×1.45. Contamination must be inspected and ≤3 mm.</p>
      </>}
      {page === 3 && <>{sheet.mel.map(m => <section key={m.item}><h3>{defects[m.item]} inoperative</h3><p>{m.dispatchAllowed ? m.conditions.join('; ') : 'Dispatch not permitted'}</p></section>)}<p>Every condition applies together. Authority, placards, endorsement and dispatch procedure are required. These are invented teaching restrictions.</p></>}
    </>}
  </div>;
}
