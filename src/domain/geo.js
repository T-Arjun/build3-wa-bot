'use strict';

/**
 * Location intelligence for founder search.
 *
 * The source `city` field is free-text and inconsistent: misspellings
 * ("Banglore"), abbreviations ("blr", "Lko"), alternate/old names ("Cochin" vs
 * "Kochi", "Bombay" vs "Mumbai"), case noise, and multi-token strings. It carries
 * no state/region, and the source API does not expose a structured location, so a
 * query like "founders from Kerala" cannot be answered by a substring match on
 * `city` alone.
 *
 * This module resolves a free-text location into the set of substring terms to
 * match against `city`, in priority order:
 *   region (e.g. NCR, South India) → state (name/abbreviation) →
 *   city alias group (alternate names + abbreviations) → mapped city →
 *   fuzzy correction (typos) → the literal input.
 *
 * Unknown input (including non-Indian cities) falls back to itself, so search
 * never regresses and a wrong state is never inferred.
 */

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Optimal string alignment (Damerau-Levenshtein) edit distance. Counts an
 * adjacent transposition as a single edit, so common typos ("mumabi"→"mumbai")
 * resolve at distance 1.
 */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// ─── City alias groups ─────────────────────────────────────────────────────────
// Each inner array is one place: alternate/old names, common misspellings, and
// abbreviations. Any member should match the others when a user searches by city.
const ALIAS_GROUPS = [
  ['bengaluru', 'bangalore', 'banglore', 'bengalore'],
  ['mumbai', 'bombay'],
  ['delhi', 'new delhi'],
  ['hyderabad', 'secunderabad'],
  ['chennai', 'madras'],
  ['kolkata', 'calcutta'],
  ['pune', 'poona'],
  ['kochi', 'cochin', 'ernakulam'],
  ['thiruvananthapuram', 'trivandrum', 'thiruvanathapuram'],
  ['kozhikode', 'calicut'],
  ['gurugram', 'gurgaon'],
  ['lucknow'],
  ['puducherry', 'pondicherry'],
  ['mangaluru', 'mangalore'],
  ['vadodara', 'baroda'],
  ['ahilyanagar', 'ahmednagar'],
  ['kalaburagi', 'gulbarga'],
  ['shivamogga', 'shimoga'],
  ['ballari', 'bellary'],
  ['vijayapura', 'bijapur'],
  ['belagavi', 'belgaum'],
  ['hubballi', 'hubli'],
  ['tumakuru', 'tumkur'],
  ['mysuru', 'mysore'],
  ['prayagraj', 'allahabad'],
  ['varanasi'],
  ['visakhapatnam'],
  ['vijayawada'],
  ['tiruchirappalli'],
  ['thoothukudi', 'tuticorin'],
  ['panaji', 'panjim'],
  ['gandhinagar'],
];

// Nicknames, abbreviations, and alt-spellings users type but that never appear as
// a real `city` value. Resolved to a canonical city BEFORE expansion and never
// emitted as match terms, so they cannot cause false substring matches.
const INPUT_ALIASES = {
  blr: 'bengaluru', bglr: 'bengaluru', blore: 'bengaluru',
  hyd: 'hyderabad',
  bom: 'mumbai',
  pun: 'pune',
  chn: 'chennai', maa: 'chennai',
  cal: 'kolkata',
  ggn: 'gurugram',
  lko: 'lucknow',
  tvm: 'thiruvananthapuram',
  pondy: 'puducherry',
  dilli: 'delhi',
  kashi: 'varanasi', banaras: 'varanasi', benaras: 'varanasi',
  vizag: 'visakhapatnam', vishakhapatnam: 'visakhapatnam',
  bezawada: 'vijayawada',
  trichy: 'tiruchirappalli', tiruchi: 'tiruchirappalli',
  gnagar: 'gandhinagar',
};

// ─── City → state ──────────────────────────────────────────────────────────────
// Covers all states/UTs: capitals, district HQs, and major cities. Spelling
// variants/abbreviations are folded in here too so every alias resolves to a state.
const CITY_STATE = {
  // Andhra Pradesh
  visakhapatnam: 'andhra pradesh', vizag: 'andhra pradesh', vijayawada: 'andhra pradesh',
  guntur: 'andhra pradesh', nellore: 'andhra pradesh', kurnool: 'andhra pradesh',
  rajahmundry: 'andhra pradesh', kakinada: 'andhra pradesh', tirupati: 'andhra pradesh',
  kadapa: 'andhra pradesh', anantapur: 'andhra pradesh', eluru: 'andhra pradesh',
  ongole: 'andhra pradesh', chittoor: 'andhra pradesh', gudivada: 'andhra pradesh',
  rayachoty: 'andhra pradesh', srikakulam: 'andhra pradesh', vizianagaram: 'andhra pradesh',
  amaravati: 'andhra pradesh', machilipatnam: 'andhra pradesh', tenali: 'andhra pradesh',
  // Arunachal Pradesh
  itanagar: 'arunachal pradesh', naharlagun: 'arunachal pradesh', pasighat: 'arunachal pradesh',
  tawang: 'arunachal pradesh',
  // Assam
  guwahati: 'assam', silchar: 'assam', dibrugarh: 'assam', jorhat: 'assam', nagaon: 'assam',
  tinsukia: 'assam', tezpur: 'assam', bongaigaon: 'assam', digboi: 'assam', dhubri: 'assam',
  sivasagar: 'assam', 'north lakhimpur': 'assam', goalpara: 'assam', karimganj: 'assam',
  // Bihar
  patna: 'bihar', gaya: 'bihar', bhagalpur: 'bihar', muzaffarpur: 'bihar', darbhanga: 'bihar',
  purnia: 'bihar', arrah: 'bihar', begusarai: 'bihar', katihar: 'bihar', munger: 'bihar',
  chhapra: 'bihar', 'bihar sharif': 'bihar', hajipur: 'bihar', sasaram: 'bihar', motihari: 'bihar',
  // Chhattisgarh
  raipur: 'chhattisgarh', bhilai: 'chhattisgarh', durg: 'chhattisgarh', bilaspur: 'chhattisgarh',
  korba: 'chhattisgarh', rajnandgaon: 'chhattisgarh', jagdalpur: 'chhattisgarh',
  raigarh: 'chhattisgarh', ambikapur: 'chhattisgarh',
  // Goa
  goa: 'goa', panaji: 'goa', panjim: 'goa', margao: 'goa', 'vasco da gama': 'goa',
  mapusa: 'goa', ponda: 'goa', 'north goa': 'goa', 'south goa': 'goa',
  // Gujarat
  ahmedabad: 'gujarat', surat: 'gujarat', vadodara: 'gujarat', baroda: 'gujarat',
  rajkot: 'gujarat', bhavnagar: 'gujarat', jamnagar: 'gujarat', gandhinagar: 'gujarat',
  junagadh: 'gujarat', anand: 'gujarat', nadiad: 'gujarat', morbi: 'gujarat', mehsana: 'gujarat',
  bharuch: 'gujarat', dahod: 'gujarat', navsari: 'gujarat', valsad: 'gujarat', vapi: 'gujarat',
  gandhidham: 'gujarat', porbandar: 'gujarat',
  // Haryana
  gurugram: 'haryana', gurgaon: 'haryana', faridabad: 'haryana', panipat: 'haryana',
  ambala: 'haryana', yamunanagar: 'haryana', rohtak: 'haryana', hisar: 'haryana',
  karnal: 'haryana', sonipat: 'haryana', panchkula: 'haryana', bhiwani: 'haryana',
  sirsa: 'haryana', bahadurgarh: 'haryana', jind: 'haryana', kurukshetra: 'haryana', rewari: 'haryana',
  // Himachal Pradesh
  shimla: 'himachal pradesh', dharamshala: 'himachal pradesh', solan: 'himachal pradesh',
  mandi: 'himachal pradesh', kullu: 'himachal pradesh', manali: 'himachal pradesh',
  palampur: 'himachal pradesh', baddi: 'himachal pradesh', 'kasauli': 'himachal pradesh',
  // Jharkhand
  ranchi: 'jharkhand', jamshedpur: 'jharkhand', dhanbad: 'jharkhand', bokaro: 'jharkhand',
  deoghar: 'jharkhand', hazaribagh: 'jharkhand', giridih: 'jharkhand', ramgarh: 'jharkhand',
  // Karnataka
  bengaluru: 'karnataka', bangalore: 'karnataka', banglore: 'karnataka', bengalore: 'karnataka',
  mysuru: 'karnataka', mysore: 'karnataka', hubballi: 'karnataka', hubli: 'karnataka',
  dharwad: 'karnataka', mangaluru: 'karnataka', mangalore: 'karnataka', belagavi: 'karnataka',
  belgaum: 'karnataka', kalaburagi: 'karnataka', gulbarga: 'karnataka', davanagere: 'karnataka',
  ballari: 'karnataka', bellary: 'karnataka', vijayapura: 'karnataka', bijapur: 'karnataka',
  shivamogga: 'karnataka', shimoga: 'karnataka', tumakuru: 'karnataka', tumkur: 'karnataka',
  raichur: 'karnataka', bidar: 'karnataka', hospet: 'karnataka', gadag: 'karnataka',
  hassan: 'karnataka', udupi: 'karnataka', chitradurga: 'karnataka', kolar: 'karnataka',
  mandya: 'karnataka',
  // Kerala
  thiruvananthapuram: 'kerala', trivandrum: 'kerala', thiruvanathapuram: 'kerala',
  kochi: 'kerala', cochin: 'kerala', ernakulam: 'kerala', kozhikode: 'kerala', calicut: 'kerala',
  thrissur: 'kerala', kollam: 'kerala', kannur: 'kerala', kottayam: 'kerala', palakkad: 'kerala',
  alappuzha: 'kerala', malappuram: 'kerala', kasaragod: 'kerala', pathanamthitta: 'kerala',
  idukki: 'kerala', wayanad: 'kerala', manjeri: 'kerala', thalassery: 'kerala', ponnani: 'kerala',
  // Madhya Pradesh
  bhopal: 'madhya pradesh', indore: 'madhya pradesh', gwalior: 'madhya pradesh',
  jabalpur: 'madhya pradesh', ujjain: 'madhya pradesh', sagar: 'madhya pradesh',
  dewas: 'madhya pradesh', satna: 'madhya pradesh', ratlam: 'madhya pradesh', rewa: 'madhya pradesh',
  katni: 'madhya pradesh', singrauli: 'madhya pradesh', burhanpur: 'madhya pradesh',
  khandwa: 'madhya pradesh', morena: 'madhya pradesh', chhindwara: 'madhya pradesh',
  vidisha: 'madhya pradesh',
  // Maharashtra
  mumbai: 'maharashtra', bombay: 'maharashtra', pune: 'maharashtra', poona: 'maharashtra',
  nagpur: 'maharashtra', thane: 'maharashtra', nashik: 'maharashtra', aurangabad: 'maharashtra',
  solapur: 'maharashtra', kalyan: 'maharashtra', dombivli: 'maharashtra',
  'kalyan dombivli': 'maharashtra', vasai: 'maharashtra', virar: 'maharashtra',
  'navi mumbai': 'maharashtra', kolhapur: 'maharashtra', amravati: 'maharashtra',
  nanded: 'maharashtra', sangli: 'maharashtra', jalgaon: 'maharashtra', akola: 'maharashtra',
  latur: 'maharashtra', ahilyanagar: 'maharashtra', ahmednagar: 'maharashtra',
  chandrapur: 'maharashtra', parbhani: 'maharashtra', ichalkaranji: 'maharashtra',
  jalna: 'maharashtra', bhiwandi: 'maharashtra', panvel: 'maharashtra', satara: 'maharashtra',
  beed: 'maharashtra', kudal: 'maharashtra', sangamner: 'maharashtra', ratnagiri: 'maharashtra',
  wardha: 'maharashtra',
  // Manipur
  imphal: 'manipur',
  // Meghalaya
  shillong: 'meghalaya', tura: 'meghalaya',
  // Mizoram
  aizawl: 'mizoram',
  // Nagaland
  kohima: 'nagaland', dimapur: 'nagaland',
  // Odisha
  bhubaneswar: 'odisha', cuttack: 'odisha', rourkela: 'odisha', berhampur: 'odisha',
  sambalpur: 'odisha', puri: 'odisha', balasore: 'odisha', baripada: 'odisha',
  jharsuguda: 'odisha', angul: 'odisha', dhenkanal: 'odisha',
  // Punjab
  ludhiana: 'punjab', amritsar: 'punjab', jalandhar: 'punjab', patiala: 'punjab',
  bathinda: 'punjab', mohali: 'punjab', hoshiarpur: 'punjab', pathankot: 'punjab',
  moga: 'punjab', firozpur: 'punjab', kapurthala: 'punjab', phagwara: 'punjab',
  // Rajasthan
  jaipur: 'rajasthan', jodhpur: 'rajasthan', udaipur: 'rajasthan', kota: 'rajasthan',
  bikaner: 'rajasthan', ajmer: 'rajasthan', bhilwara: 'rajasthan', alwar: 'rajasthan',
  sikar: 'rajasthan', pali: 'rajasthan', 'sri ganganagar': 'rajasthan', tonk: 'rajasthan',
  bharatpur: 'rajasthan', hanumangarh: 'rajasthan', churu: 'rajasthan', nagaur: 'rajasthan',
  dausa: 'rajasthan', banswara: 'rajasthan',
  // Sikkim
  gangtok: 'sikkim',
  // Tamil Nadu
  chennai: 'tamil nadu', madras: 'tamil nadu', coimbatore: 'tamil nadu', madurai: 'tamil nadu',
  tiruchirappalli: 'tamil nadu', trichy: 'tamil nadu', salem: 'tamil nadu',
  tirunelveli: 'tamil nadu', erode: 'tamil nadu', vellore: 'tamil nadu',
  thoothukudi: 'tamil nadu', tuticorin: 'tamil nadu', dindigul: 'tamil nadu',
  thanjavur: 'tamil nadu', ranipet: 'tamil nadu', nagercoil: 'tamil nadu',
  kanchipuram: 'tamil nadu', karur: 'tamil nadu', hosur: 'tamil nadu', cuddalore: 'tamil nadu',
  kumbakonam: 'tamil nadu', tiruppur: 'tamil nadu', sivakasi: 'tamil nadu',
  auroville: 'tamil nadu', ooty: 'tamil nadu',
  // Telangana
  hyderabad: 'telangana', secunderabad: 'telangana', warangal: 'telangana',
  nizamabad: 'telangana', karimnagar: 'telangana', khammam: 'telangana', ramagundam: 'telangana',
  mahbubnagar: 'telangana', nalgonda: 'telangana', siddipet: 'telangana', suryapet: 'telangana',
  // Tripura
  agartala: 'tripura',
  // Uttar Pradesh
  lucknow: 'uttar pradesh', kanpur: 'uttar pradesh', ghaziabad: 'uttar pradesh',
  agra: 'uttar pradesh', varanasi: 'uttar pradesh', meerut: 'uttar pradesh',
  prayagraj: 'uttar pradesh', allahabad: 'uttar pradesh', bareilly: 'uttar pradesh',
  aligarh: 'uttar pradesh', moradabad: 'uttar pradesh', saharanpur: 'uttar pradesh',
  gorakhpur: 'uttar pradesh', noida: 'uttar pradesh', 'greater noida': 'uttar pradesh',
  firozabad: 'uttar pradesh', jhansi: 'uttar pradesh', muzaffarnagar: 'uttar pradesh',
  mathura: 'uttar pradesh', ayodhya: 'uttar pradesh', rampur: 'uttar pradesh',
  shahjahanpur: 'uttar pradesh', bijnor: 'uttar pradesh', etawah: 'uttar pradesh',
  mirzapur: 'uttar pradesh', bulandshahr: 'uttar pradesh', sitapur: 'uttar pradesh',
  // Uttarakhand
  dehradun: 'uttarakhand', haridwar: 'uttarakhand', roorkee: 'uttarakhand',
  haldwani: 'uttarakhand', rishikesh: 'uttarakhand', rudrapur: 'uttarakhand',
  kashipur: 'uttarakhand', nainital: 'uttarakhand', mussoorie: 'uttarakhand', almora: 'uttarakhand',
  // West Bengal
  kolkata: 'west bengal', calcutta: 'west bengal', howrah: 'west bengal', durgapur: 'west bengal',
  asansol: 'west bengal', siliguri: 'west bengal', bardhaman: 'west bengal', malda: 'west bengal',
  kharagpur: 'west bengal', haldia: 'west bengal', jalpaiguri: 'west bengal',
  darjeeling: 'west bengal', krishnanagar: 'west bengal',
  // Delhi (UT)
  delhi: 'delhi', 'new delhi': 'delhi', 'north delhi': 'delhi', 'south delhi': 'delhi',
  'east delhi': 'delhi', 'west delhi': 'delhi', 'central delhi': 'delhi',
  // Jammu & Kashmir (UT)
  srinagar: 'jammu and kashmir', jammu: 'jammu and kashmir', anantnag: 'jammu and kashmir',
  baramulla: 'jammu and kashmir', sopore: 'jammu and kashmir', udhampur: 'jammu and kashmir',
  kathua: 'jammu and kashmir',
  // Ladakh (UT)
  leh: 'ladakh', kargil: 'ladakh',
  // Puducherry (UT)
  puducherry: 'puducherry', pondicherry: 'puducherry', karaikal: 'puducherry',
  yanam: 'puducherry', mahe: 'puducherry',
  // Chandigarh (UT)
  chandigarh: 'chandigarh',
  // Andaman & Nicobar (UT)
  'port blair': 'andaman and nicobar islands',
  // Dadra & Nagar Haveli and Daman & Diu (UT)
  daman: 'dadra and nagar haveli and daman and diu', diu: 'dadra and nagar haveli and daman and diu',
  silvassa: 'dadra and nagar haveli and daman and diu',
  // Lakshadweep (UT)
  kavaratti: 'lakshadweep',
};

// ─── State name variants users might type ──────────────────────────────────────
// Only high-value, low-collision codes + descriptive variant spellings. Two-letter
// codes that are common English words or non-Indian places (uk=United Kingdom,
// or/as=English words, ga=Georgia, hr=HR, br=Brazil, ar=Arkansas, plus the rarely
// typed NE codes) are deliberately omitted - the full state name still resolves.
const STATE_ALIASES = {
  ap: 'andhra pradesh',
  cg: 'chhattisgarh', chattisgarh: 'chhattisgarh',
  gj: 'gujarat',
  hp: 'himachal pradesh', himachal: 'himachal pradesh',
  jh: 'jharkhand',
  ka: 'karnataka', karnatka: 'karnataka',
  kl: 'kerala', keralam: 'kerala',
  mp: 'madhya pradesh',
  mh: 'maharashtra', maha: 'maharashtra',
  od: 'odisha', orissa: 'odisha',
  pb: 'punjab',
  rj: 'rajasthan', rajastan: 'rajasthan',
  tn: 'tamil nadu', tamilnadu: 'tamil nadu',
  ts: 'telangana', tg: 'telangana', telengana: 'telangana',
  up: 'uttar pradesh',
  ua: 'uttarakhand', uttaranchal: 'uttarakhand',
  wb: 'west bengal',
  jk: 'jammu and kashmir', 'j&k': 'jammu and kashmir', kashmir: 'jammu and kashmir',
  py: 'puducherry',
};

// ─── Multi-state metro regions & zones ─────────────────────────────────────────
// A region spans cities across several states, so it can't be a state alias.
// NCR must include Gurgaon (Haryana) and Noida (UP), not just Delhi. Zones expand
// to the union of their member states' cities.
const REGIONS = {
  ncr: ['delhi', 'new delhi', 'south delhi', 'north delhi', 'gurugram', 'gurgaon', 'noida', 'greater noida', 'ghaziabad', 'faridabad'],
};
REGIONS['delhi ncr'] = REGIONS.ncr;
REGIONS['national capital region'] = REGIONS.ncr;

// Zones → member states (expanded to all their cities below, after derived maps).
const ZONE_STATES = {
  'south india': ['andhra pradesh', 'telangana', 'karnataka', 'kerala', 'tamil nadu', 'puducherry'],
  'north india': ['delhi', 'haryana', 'punjab', 'uttar pradesh', 'uttarakhand', 'himachal pradesh', 'rajasthan', 'jammu and kashmir', 'chandigarh'],
  'north east': ['assam', 'arunachal pradesh', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'tripura', 'sikkim'],
  northeast: ['assam', 'arunachal pradesh', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'tripura', 'sikkim'],
  'north east india': ['assam', 'arunachal pradesh', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'tripura', 'sikkim'],
};

// ─── Derived maps (built once) ─────────────────────────────────────────────────
const STATE_TO_CITIES = {};
for (const [city, state] of Object.entries(CITY_STATE)) {
  (STATE_TO_CITIES[state] = STATE_TO_CITIES[state] || []).push(city);
}
const STATES = new Set(Object.keys(STATE_TO_CITIES));

const ALIAS_LOOKUP = {}; // any variant → full group
for (const group of ALIAS_GROUPS) {
  for (const member of group) ALIAS_LOOKUP[member] = group;
}

// Expand zones to the union of their member states' cities + the state names.
for (const [zone, states] of Object.entries(ZONE_STATES)) {
  const terms = new Set();
  for (const st of states) {
    terms.add(st);
    for (const c of STATE_TO_CITIES[st] || []) terms.add(c);
  }
  REGIONS[zone] = Array.from(terms);
}

// Every known token, for fuzzy correction.
const ALL_KNOWN = new Set([
  ...Object.keys(CITY_STATE),
  ...STATES,
  ...Object.keys(STATE_ALIASES),
  ...Object.keys(REGIONS),
]);

/**
 * Find the closest known city/state/alias for a likely-misspelled token.
 * Conservative: only single tokens of length >= 4, distance <= 1 (len <= 6) or
 * <= 2 (longer), and only when the best match is unambiguously better than the
 * next. Returns the matched key, or null.
 */
function closestKnown(token) {
  if (!token || token.length < 4 || token.includes(' ')) return null;
  if (ALL_KNOWN.has(token)) return token;
  const maxDist = token.length > 6 ? 2 : 1;
  let best = null;
  let bestD = Infinity;
  let secondD = Infinity;
  for (const key of ALL_KNOWN) {
    if (key.includes(' ')) continue;
    if (Math.abs(key.length - token.length) > maxDist) continue;
    const dist = editDistance(token, key);
    if (dist < bestD) {
      secondD = bestD;
      bestD = dist;
      best = key;
    } else if (dist < secondD) {
      secondD = dist;
    }
  }
  return best && bestD <= maxDist && bestD < secondD ? best : null;
}

/**
 * Resolve a known (already-canonical) token to its match terms: a region, a
 * state, a city alias group, or a single mapped/literal city.
 */
function resolveKnown(q) {
  if (REGIONS[q]) {
    return { isState: false, isRegion: true, state: null, terms: Array.from(new Set(REGIONS[q])) };
  }
  const stateName = STATES.has(q) ? q : STATE_ALIASES[q];
  if (stateName && STATE_TO_CITIES[stateName]) {
    return { isState: true, state: stateName, terms: Array.from(new Set([stateName, ...STATE_TO_CITIES[stateName]])) };
  }
  const group = ALIAS_LOOKUP[q];
  if (group) return { isState: false, state: CITY_STATE[q] || null, terms: Array.from(new Set([q, ...group])) };
  if (CITY_STATE[q]) return { isState: false, state: CITY_STATE[q], terms: [q] };
  return null;
}

/**
 * Expand a free-text location into the set of substring terms to match against
 * the `city` field.
 *
 * @returns {{ isState: boolean, isRegion?: boolean, state: ?string, terms: string[], fuzzy?: string }}
 *   terms are lowercase substrings; a row matches if `city` ILIKE %term% for ANY.
 */
function expandLocation(text) {
  let q = normalize(text);
  if (!q) return { isState: false, state: null, terms: [] };

  // Map a nickname/abbreviation ("blr", "bom") to its canonical city first, so it
  // expands to real spellings and is never itself emitted as a (false-matching)
  // substring term.
  if (INPUT_ALIASES[q]) q = INPUT_ALIASES[q];

  const known = resolveKnown(q);
  if (known) return known;

  // Typo correction as a last resort before giving up.
  const corrected = closestKnown(q);
  if (corrected && corrected !== q) {
    const viaFuzzy = resolveKnown(corrected);
    if (viaFuzzy) return { ...viaFuzzy, fuzzy: corrected };
  }

  // Unknown (e.g. a non-Indian city) → match it literally; never guess a state.
  return { isState: false, state: null, terms: [q] };
}

/**
 * Tokens to fold into a founder's search_blob at sync time so free-text search
 * ("kerala", "cochin") matches even when the city field says "Kochi". Returns the
 * state and any alias variants for the given city string. Matches whole words so
 * "goa" does not match "goalpara".
 */
function blobLocationTokens(cityRaw) {
  const q = normalize(cityRaw);
  if (!q) return [];
  const tokens = new Set();
  for (const [city, state] of Object.entries(CITY_STATE)) {
    const re = new RegExp(`(^|\\s)${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`);
    if (re.test(q)) {
      tokens.add(state);
      const group = ALIAS_LOOKUP[city];
      if (group) group.forEach((g) => tokens.add(g));
    }
  }
  return Array.from(tokens);
}

module.exports = {
  normalize,
  editDistance,
  closestKnown,
  expandLocation,
  blobLocationTokens,
  CITY_STATE,
  STATE_TO_CITIES,
};
