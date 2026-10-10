import { rulesStrand as editionRulesStrand } from '../../../../training/src/levels.ts';
import * as c from './checks';
import type { Decree, Edition, RealRule, RuleVariant, Strand } from './model';

type Pair = Omit<Decree, 'shiftIntroduced' | 'easa' | 'ca'>;
const EAR = 'https://www.easa.europa.eu/en/document-library/easy-access-rules/easy-access-rules-aircrew-regulation-eu-no-11782011';
const TP690 = 'https://tc.canada.ca/en/aviation/publications/study-reference-guide-written-examinations-airline-transport-pilot-licence-aeroplane-tp-690';
const TEACHING = new Set(['crosswind', 'icing', 'takeoff-distance', 'landing-distance', 'contaminated-runway', 'density-altitude', 'mel', 'notams']);

const verified='2026-10-09';
const au91='https://www.legislation.gov.au/F2020L01514/2026-07-09/2026-07-09/text/original/pdf';
const au121='https://www.legislation.gov.au/F2020L01561/2026-03-14/2026-03-14/text/original/pdf';
const au135='https://www.legislation.gov.au/F2020L01622/2026-07-09/2026-07-09/text/original/epub/OEBPS/document_1/document_1.html';
const au61='https://www.legislation.gov.au/F1998B00220/2026-06-30/2026-06-30/text/original/epub/OEBPS/document_2/document_2.html';
function au(section:string,scope:string,url=au91,document='CASA Part 91 MOS 2020'):RealRule { return {document,section,url,scope,verified}; }
function us(section:string,scope:string):RealRule { return {document:'14 CFR',section,url:`https://www.ecfr.gov/current/title-14/section-${section.match(/^\d+\.\d+/)?.[0]}`,scope,verified}; }
const performanceAU=au('91.095(2)','Comply with flight manual instructions. The Code distances, crosswinds, contamination and icing restrictions are invented teaching limitations; real AFM/dispatch calculations replace them.',au61,'CASR Part 91');
const performanceUS=us('91.103(b); 91.9(a)','Use runway/performance information and approved limitations; fictional teaching dispatch distances include a margin and are not unfactored AFM landing distances.');
function variant(check:RuleVariant['check'],realRule:RealRule[],citation:string,reason:string,question:string,remedy:string,parameters:RuleVariant['parameters']={}):RuleVariant {
  return {check,realRule,citation,reason,parameters,decisionTree:[
    {id:'check',question,yes:'PASS',no:'resolve'},
    {id:'resolve',question:remedy,yes:'AMEND_AND_RECHECK',no:'REFUSE'},
  ]};
}
function rule(id:string,title:string,conceptId:string,strand:Decree['strand'],check:(...args:Parameters<RuleVariant['check']>)=>ReturnType<RuleVariant['check']>, auRefs:RealRule[],usRefs:RealRule[],citation:string,reason:string,question:string,remedy:string,parameters:RuleVariant['parameters']={}):Pair {
  return {id,title,conceptId,strand,au:variant(check,auRefs,`AUS · ${citation}`,reason,question,remedy,parameters),us:variant(check,usRefs,`US · ${citation}`,reason,question,remedy,parameters)};
}
const both=(auCheck:RuleVariant['check'],usCheck:RuleVariant['check'],entry:Pair,auParameters:RuleVariant['parameters']={},usParameters:RuleVariant['parameters']={}):Pair => ({...entry,au:{...entry.au,check:auCheck,parameters:{...entry.au.parameters,...auParameters}},us:{...entry.us,check:usCheck,parameters:{...entry.us.parameters,...usParameters}}});

function gapVariant(label:'EASA'|'CAN',document:string,url:string):RuleVariant {
  const reason=`${label} numbers are not loaded for this decree.`;
  return variant(()=>({status:'unavailable',detail:reason}),
    [{document,section:'gap',url,scope:`${label} legal numbers are not substituted.`,verified}],
    `${label} · gap`,reason,'Are the national numbers loaded?','Use the Australian or US edition until this text is loaded.');
}
function reuseUs(source:RuleVariant,edition:'easa'|'ca'):RuleVariant {
  if(edition==='ca')return {...source,citation:'CAN · reuses US',reuses:'us',realRule:source.realRule.map(rule=>({...rule,scope:`${rule.scope} CAN reuses the US teaching check.`}))};
  return {...source,citation:'EASA · teaching check; national Part-CAT/NCO text is not substituted',reuses:'us',realRule:[{document:'Easy Access Rules for Aircrew',section:'Part-FCL',url:EAR,verified,scope:'Teaching check only. National Part-CAT/NCO text is not substituted.'}]};
}
function withEditions(entry:Pair):Omit<Decree,'shiftIntroduced'> {
  return {...entry,
    easa:TEACHING.has(entry.id)?reuseUs(entry.us,'easa'):gapVariant('EASA','Easy Access Rules for Aircrew',EAR),
    ca:TEACHING.has(entry.id)?reuseUs(entry.us,'ca'):gapVariant('CAN','Transport Canada TP 690E',TP690)};
}

const catalogue:Pair[]=[
  both(d=>c.coverage(d,'aus'),d=>c.coverage(d,'us'),rule('forecast-coverage','Forecast time of use','met.taf-groups','charts',d=>c.coverage(d,'aus'),
    [au('7.02(6); 8.04(3)','Code requires a bounded destination forecast; real Part 91 can instead nominate an alternate when the destination forecast is unavailable.')],
    [us('91.169(b)','Code uses a TAF covering the entire 1-2-3 window; the real rule allows appropriate reports/forecasts in combination.')],
    'Use a forecast that covers the planning window.','Weather outside the forecast has not been predicted.',
    'Does the destination forecast cover the complete time window?','Can a delay place the whole window inside a valid forecast?'),{beforeMinutes:30,afterMinutes:60},{beforeMinutes:60,afterMinutes:60}),
  both(d=>c.alternateCheck(d,'aus',false),d=>c.alternateCheck(d,'us',false),rule('destination-alternate','Destination alternate','law.alternate','rules',d=>c.alternateCheck(d,'aus',false),
    [au('8.02; 8.04; 8.08','Part 91 IFR: stated alternate minima and adverse periods buffered ±30 minutes. Every Code-nominated alternate must be suitable; no prevailing-weather holding substitution.'),au('4.08','Airline dispatch: the Code always nominates an alternate, without taking the exceptions.',au121,'CASA Part 121 MOS 2020')],
    [us('91.169(b)–(c)','Part 91: IAP plus 2000 ft/3 SM throughout destination ETA ±1 hour. A nominated alternate must meet its stated minima at diversion ETA, even when optional.'),us('121.619(a)','Domestic Part 121 1-2-3 window.'),us('135.223(b)','Charter: no circling approach, ceiling max(2000 ft, approach height +1500 ft); visibility max(3 SM, approach +2 SM).')],
    'Nominate a suitable alternate when the destination fails its planning minima.','An approach can be legal to attempt while a diversion still needs planning.',
    'Are prevailing conditions above this operation’s alternate threshold?','Is an open, weather-suitable alternate within the fuel plan?'),{bufferMinutes:30,minima:'stated approach card'},{bufferMinutes:60,privateCeilingFt:2000,privateVisibilitySM:3}),
  both(d=>c.alternateCheck(d,'aus',true),d=>c.alternateCheck(d,'us',true),rule('forecast-groups','Temporary and probability groups','met.taf-groups','charts',d=>c.alternateCheck(d,'aus',true),
    [au('8.02; 8.04(6)–(8)','Part 91 INTER/TEMPO holding; conservative Code counts all PROB groups and does not use the TAF3 concession.')],
    [us('91.169(b)','Code conservatively counts temporary/probability groups in the US alternate assessment, with no holding substitution.')],
    'Temporary and probability weather can require a diversion plan.','A brief deterioration still coincides with some arrivals.',
    'Do all additional groups satisfy the alternate threshold?','Is there a suitable alternate or holding allowed by this edition?'),{interHoldingMinutes:30,tempoHoldingMinutes:60},{holdingSubstitution:false}),
  rule('crosswind','Runway wind component','fpl.wind-component','numbers',c.crosswind,[performanceAU],[performanceUS],
    'Compare gust crosswind with the runway-state teaching limit.','A wet runway leaves less directional-control margin.',
    'Are departure and arrival crosswinds within their limits?','Can a permitted amendment remove the excess wind?',{directions:'true',gusts:true}),
  rule('icing','Icing capability','sys.anti-ice','physics',c.icing,[au('26.04','Equipment serviceability supports this fictional no-icing MEL condition; freezing-level plus stipulated cloud exposure is a teaching risk proxy.')],[us('91.9(a)','Aircraft limitations; freezing level alone is not an icing forecast.')],
    'No stipulated cloud exposure above freezing level with anti-ice deferred.','Supercooled liquid can ice an unprotected airframe.',
    'Does the aircraft have icing capability for the stipulated cloud exposure?','Can a permitted delay remove the exposure?',{proxy:'stipulated cloud exposure AND cruise above either endpoint model freezing level'}),
  both(d=>c.thunderstorms(d,'aus'),d=>c.thunderstorms(d,'us'),rule('thunderstorms','Convective waiting fuel','met.thunderstorm','operations',d=>c.thunderstorms(d,'aus'),
    [au('8.02(1)(c)–(d); 8.04','Code requires waiting fuel or delay for a destination thunderstorm; it does not authorise penetration.')],[us('91.103(a)','Code storm holding/delay restriction is a conservative operator teaching rule, not a US fixed statutory holding duration.')],
    'Plan to wait or delay clear of the thunderstorm.','Reserve fuel must not be spent waiting out a hazard.',
    'Is the destination free of thunderstorms in the planning window?','Does the waiting fuel cover the event, or can the flight be delayed?')),
  both(d=>c.fuel(d,'aus'),d=>c.fuel(d,'us'),rule('fuel','Usable fuel ledger','fpl.fuel-plan','numbers',d=>c.fuel(d,'aus'),
    [au('19.02–19.04','Private aeroplanes; no additional critical-point fuel scenario in v1.'),au('7.02–7.05','Airline turbine: 5%/minimum 5-minute contingency, 30-minute holding final reserve, 15-minute no-alternate component.',au121,'CASA Part 121 MOS 2020'),au('7.02; 7.04','Charter: piston 10%/45 min; turbine 5%/30 min, minimum five-minute contingency.',au135,'CASA Part 135 MOS 2020')],
    [us('91.151; 91.167','Private day VFR 30 minutes; night VFR/IFR 45 minutes, normal cruise.'),us('121.639','Domestic airline IFR 45-minute normal-cruise reserve; VFR airline operations excluded.'),us('135.209; 135.223(a)','Charter day VFR 30 minutes, night/IFR 45-minute normal-cruise reserve.')],
    'Carry trip, diversion, holding and the applicable reserves.','A usable-fuel ledger protects the final landing reserve.',
    'Does usable fuel cover every required component and fit the tanks?','Can fuel be added without exceeding tank or weight limits?'),{reserveBasis:'holding'},{reserveBasis:'normal-cruise'}),
  both(d=>c.duty(d,'aus'),d=>c.duty(d,'us'),rule('duty','Crew duty roster','hum.fatigue-rules','rules',d=>c.duty(d,'aus'),
    [{document:'CAO 48.1 Instrument 2019',section:'Appendix 1 §§1, 2, 4; §16',url:'https://www.legislation.gov.au/F2019L01070/latest/text',verified,scope:'Only an operator electing Appendix 1 Basic Limits, home base, acclimatised, starts 0700 or later. Other cumulative/late duty checks stipulated complete; no extensions/FRMS. Not universal airline limits.'}],
    [us('117.13; 117.25','Acclimatised unaugmented passenger airline; Tables A/B, prior rest and weekly break. No extension/augmented/reserve scenarios.'),us('135.267','Unscheduled charter one/two-pilot baseline, stipulated regular duty/rest pattern; other cumulative checks complete.')],
    'Check the scheme, start, sectors, duty and rest together.','Time awake and circadian timing constrain performance independently of rank.',
    'Does the roster fit the stated scheme and rest requirements?','Can a permitted amendment restore compliance without assuming new rest?'),{scheme:'CAO48.1 Appendix1',fdpHours:9,lateFdpHours:8,restHours:12},{scheme:'117 or 135 by operation',restHours:10}),
  rule('takeoff-distance','Take-off field requirement','perf.takeoff-factors','operations',d=>c.distance(d,'takeoff'),[performanceAU],[performanceUS],
    'Use the actual take-off mass, flap and atmospheric/runway corrections.','A hotter, higher or heavier departure needs more runway.',
    'Do mass and corrected take-off distance fit?','Can an allowed amendment make the whole plan fit?'),
  rule('landing-distance','Landing field requirement','perf.landing-distance','operations',d=>c.distance(d,'landing'),[performanceAU],[performanceUS],
    'Check landing mass and corrected teaching dispatch distance.','Fuel added to solve one problem can create a landing-mass problem.',
    'Do landing mass and distance fit the selected runway?','Can a permitted amendment remove the conflict?'),
  rule('contaminated-runway','Contaminated runway report','perf.takeoff-factors','operations',c.contaminated,[performanceAU],[performanceUS],
    'Use the contaminated-runway sheet only within its stated conditions.','Unknown braking cannot be treated as dry braking.',
    'Is contamination inspected and within the 3 mm teaching envelope?','Can a permitted delay provide a new valid assessment?',{maxDepthMm:3}),
  rule('density-altitude','Atmospheric worksheet','perf.density-altitude','physics',c.density,[performanceAU],[performanceUS],
    'Calculate pressure altitude before the temperature correction.','Less dense air reduces thrust and lift.',
    'Does the worksheet match QNH, elevation and temperature?','Can the worksheet be corrected before resubmission?',{toleranceFt:100,ftPerHpa:27,ftPerDegreeC:120}),
  rule('mel','Deferred equipment','sys.mel-dispatch','operations',c.mel,[au('26.04','Only an authorised MEL/permissible unserviceability permits deferral; item restrictions here are wholly invented.')],[us('91.213(a)','Approved MEL dispatch framework; the game items are not an approved MEL.')],
    'All deferral conditions must hold together.','A second defect can remove the protection that made the first deferral tolerable.',
    'Are authority, placards and every item condition satisfied?','Can a permitted amendment satisfy every condition?'),
  both(d=>c.licence(d,'aus'),d=>c.licence(d,'us'),rule('licence-medical','Crew credentials','law.documents','rules',d=>c.licence(d,'aus'),
    [au('61.375; 61.400; 61.415','Ratings, review and current medical; expiry dates are supplied by documents, no general expiry calculation.',au61,'CASR Part 61')],
    [us('61.3; 61.23; 61.31','Certificates, medical privileges and type ratings; supplied expiry dates. All airline crew use captain privileges in this exercise.')],
    'Credentials must authorise the aircraft and the planned operation.','A valid licence alone does not confer every privilege.',
    'Are the required credentials, ratings, review and medical current?','Can a permitted amendment fix the document mismatch?'),{commercialMedicalClass:1},{commercialMedicalClass:2}),
  both(d=>c.recency(d,'aus'),d=>c.recency(d,'us'),rule('passenger-recency','Passenger recent experience','law.documents','rules',d=>c.recency(d,'aus'),
    [au('61.395','Same-category logged events with 500 ft climb stipulated. No flight-check exemptions; Australian night definition.',au61,'CASR Part 61')],[us('61.57(a)–(b)','Same class/type sole-manipulator events stipulated. Night events mean one hour after sunset to one hour before sunrise; full stops required.')],
    'Check the logbook for the passenger privilege being exercised.','Recent hands-on landings matter when others depend on the pilot.',
    'Are there three qualifying take-offs and landings in the previous 90 days?','Can a permitted amendment make the pilot current?',{windowDays:90}),{nightFullStop:false},{nightFullStop:true}),
  rule('maintenance-release','Release to service','law.documents','operations',c.maintenance,[au('10.02(g); 26.04','Maintenance release or certificate of release to service; fictional next-inspection hours are stipulated document limits.')],[us('91.7; 91.405','Airworthiness and maintenance obligations; the republic release form represents the required records, not a universal US maintenance-release form.')],
    'The maintenance authority and defect record must cover the flight.','Dispatch is not a substitute for release to service.',
    'Is the release signed, current and consistent with the technical log?','Can a permitted amendment restore a valid release?'),
  rule('notams','Aerodrome notices','law.documents','charts',c.notams,[au('10.02(b)','Relevant FIR and location NOTAM review before take-off.')],[us('91.103','Available preflight information includes runway availability; Code requires explicit acknowledgement.')],
    'Check active notices for the selected runway.','A forecast says nothing about a closed runway.',
    'Are notices acknowledged and the selected runways open at time of use?','Can delaying beyond the closure restore availability?'),
  both(d=>c.vfr(d,'aus'),d=>c.vfr(d,'us'),rule('vfr','Visual separation from cloud','law.vfr-minima','rules',d=>c.vfr(d,'aus'),
    [au('2.07, Table 2.07(3)','Class C aeroplane below 10,000 ft; no special VFR or NVIS.')],[us('91.155(a)','Class C aeroplane basic VFR, below 10,000 ft in these exercises.')],
    'Visibility and every cloud separation must meet the edition in force.','Visual flight needs room to see traffic and avoid cloud.',
    'Does visibility and all three cloud separations meet the stated Class C rule?','Can a permitted amendment restore VMC?'),{visibilityM:5000,belowFt:1000,aboveFt:1000,horizontalM:1500},{visibilityM:4828.032,belowFt:500,aboveFt:1000,horizontalM:609.6}),
  rule('manifest','Passenger authority and load','law.documents','rules',c.manifest,[au('61.113(2); 91.095(2)','Student passenger prohibition and aircraft occupancy limits. Code disallows paid private flights without modelling exceptions.',au61,'CASR Parts 61 and 91')],[us('61.89(a); 91.9','Student passenger prohibition and aircraft limitations. Code excludes paid private flights without modelling exceptions.')],
    'Match passengers, seats and the declared operation.','An important passenger does not change aircraft or licence limits.',
    'Does the manifest fit the seats and passenger privileges?','Can a permitted amendment remove the mismatch?'),
];

export const DECREES:readonly Decree[]=catalogue.map(withEditions).map((entry,i)=>({...entry,shiftIntroduced:i+1}));
export function decree(id:string):Decree {const entry=DECREES.find(d=>d.id===id);if(!entry)throw new RangeError(`Unknown decree ${id}`);return entry;}
export function editionVariant(d:Decree,edition:Edition):RuleVariant {
  if(edition==='aus')return d.au;
  if(edition==='us')return d.us;
  if(edition==='easa')return d.easa;
  if(edition==='ca')return d.ca;
  throw new RangeError('Unsupported Code edition');
}
export function ruleStrand(d:Decree,edition:Edition):Strand {return d.strand==='rules'?editionRulesStrand(edition):d.strand;}
