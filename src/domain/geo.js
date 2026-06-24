'use strict';

/**
 * Location intelligence for founder search.
 *
 * The source `city` field is free-text and messy: misspellings ("Banglore",
 * "Thiruvanathapuram"), abbreviations ("Lko"), alt names ("Cochin" vs "Kochi"),
 * case noise ("BENGALURU"), and multi-city strings ("Goa/Kanpur"). It carries no
 * state/region info, and the source API does NOT expose linkedinData.location
 * (which the website uses), so "founders from Kerala" can't be answered by a
 * substring match on `city` alone.
 *
 * This module gives us:
 *   - a city → state map (built from the cities actually present in our data),
 *   - alias groups so "Bangalore" also matches "Bengaluru", etc.,
 *   - expandLocation(text): turn a city OR a state/region into the full set of
 *     substring terms to match against the `city` field.
 *
 * Unknown input falls back to itself, so search never regresses for places we
 * haven't mapped.
 */

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// City spelling/name variants that refer to the same place. Each inner array is
// one place; any member should match the others when a user searches by city.
const ALIAS_GROUPS = [
  ['bengaluru', 'bangalore', 'banglore', 'bengalore'],
  ['kochi', 'cochin', 'ernakulam'],
  ['thiruvananthapuram', 'trivandrum', 'thiruvanathapuram', 'tvm'],
  ['kozhikode', 'calicut'],
  ['gurugram', 'gurgaon'],
  ['lucknow', 'lko'],
  ['puducherry', 'pondicherry'],
  ['mumbai', 'bombay'],
  ['kolkata', 'calcutta'],
  ['mangaluru', 'mangalore'],
  ['vadodara', 'baroda'],
  ['ahilyanagar', 'ahmednagar'],
  ['gulbarga', 'kalaburagi'],
];

// city (normalized, canonical or variant) → state. Built from the ~98 distinct
// city values present in our directory plus common Indian metros.
const CITY_STATE = {
  // Karnataka
  bengaluru: 'karnataka', bangalore: 'karnataka', banglore: 'karnataka',
  mangaluru: 'karnataka', mangalore: 'karnataka', shimoga: 'karnataka',
  gulbarga: 'karnataka', kalaburagi: 'karnataka', gadag: 'karnataka',
  tumakuru: 'karnataka', mysuru: 'karnataka', mysore: 'karnataka', hubli: 'karnataka',
  // Maharashtra
  mumbai: 'maharashtra', pune: 'maharashtra', nagpur: 'maharashtra',
  kudal: 'maharashtra', sangamner: 'maharashtra', parbhani: 'maharashtra',
  akola: 'maharashtra', ahilyanagar: 'maharashtra', ahmednagar: 'maharashtra',
  'kalyan dombivli': 'maharashtra', kalyan: 'maharashtra', nashik: 'maharashtra', thane: 'maharashtra',
  // Delhi NCR
  delhi: 'delhi', 'new delhi': 'delhi', 'south delhi': 'delhi', 'north delhi': 'delhi',
  // Telangana
  hyderabad: 'telangana', warangal: 'telangana',
  // Goa
  goa: 'goa', 'north goa': 'goa', 'south goa': 'goa', panaji: 'goa', margao: 'goa',
  // Haryana
  gurugram: 'haryana', gurgaon: 'haryana', faridabad: 'haryana',
  // Uttar Pradesh
  noida: 'uttar pradesh', lucknow: 'uttar pradesh', lko: 'uttar pradesh',
  moradabad: 'uttar pradesh', bijnor: 'uttar pradesh', varanasi: 'uttar pradesh',
  ghaziabad: 'uttar pradesh', kanpur: 'uttar pradesh', agra: 'uttar pradesh', prayagraj: 'uttar pradesh',
  // Gujarat
  ahmedabad: 'gujarat', surat: 'gujarat', vadodara: 'gujarat', baroda: 'gujarat',
  dahod: 'gujarat', rajkot: 'gujarat',
  // Tamil Nadu
  chennai: 'tamil nadu', coimbatore: 'tamil nadu', tirunelveli: 'tamil nadu',
  vellore: 'tamil nadu', madurai: 'tamil nadu', auroville: 'tamil nadu',
  // West Bengal
  kolkata: 'west bengal', calcutta: 'west bengal', siliguri: 'west bengal',
  // Rajasthan
  jodhpur: 'rajasthan', jaipur: 'rajasthan', udaipur: 'rajasthan', kota: 'rajasthan',
  // Madhya Pradesh
  indore: 'madhya pradesh', bhopal: 'madhya pradesh', gwalior: 'madhya pradesh', jabalpur: 'madhya pradesh',
  // Kerala
  kochi: 'kerala', cochin: 'kerala', ernakulam: 'kerala',
  thiruvananthapuram: 'kerala', trivandrum: 'kerala', thiruvanathapuram: 'kerala', tvm: 'kerala',
  kozhikode: 'kerala', calicut: 'kerala', kollam: 'kerala', kottayam: 'kerala',
  thrissur: 'kerala', kannur: 'kerala', palakkad: 'kerala', alappuzha: 'kerala', kasaragod: 'kerala',
  // Bihar
  patna: 'bihar', 'bihar sharif': 'bihar', gaya: 'bihar',
  // Assam
  tezpur: 'assam', digboi: 'assam', guwahati: 'assam', 'north lakhimpur': 'assam',
  // Jammu & Kashmir / Ladakh
  jammu: 'jammu and kashmir', srinagar: 'jammu and kashmir', leh: 'ladakh',
  // Chhattisgarh
  raipur: 'chhattisgarh', durg: 'chhattisgarh', bhilai: 'chhattisgarh',
  // Punjab
  jalandhar: 'punjab', amritsar: 'punjab', ludhiana: 'punjab', mohali: 'punjab',
  // Jharkhand
  ranchi: 'jharkhand', jamshedpur: 'jharkhand',
  // Odisha
  bhubaneswar: 'odisha', jharsuguda: 'odisha', cuttack: 'odisha',
  // Andhra Pradesh
  visakhapatnam: 'andhra pradesh', gudivada: 'andhra pradesh', krishna: 'andhra pradesh',
  rayachoty: 'andhra pradesh', vijayawada: 'andhra pradesh', tirupati: 'andhra pradesh',
  // Puducherry
  puducherry: 'puducherry', pondicherry: 'puducherry',
  // Uttarakhand
  rishikesh: 'uttarakhand', dehradun: 'uttarakhand', haridwar: 'uttarakhand',
  // Himachal Pradesh
  dharamshala: 'himachal pradesh', shimla: 'himachal pradesh', manali: 'himachal pradesh',
  // Meghalaya
  shillong: 'meghalaya',
};

// State name variants users might type.
const STATE_ALIASES = {
  'jk': 'jammu and kashmir',
  'j&k': 'jammu and kashmir',
  'tn': 'tamil nadu',
  'up': 'uttar pradesh',
  'mp': 'madhya pradesh',
  'ap': 'andhra pradesh',
  'wb': 'west bengal',
};

// Multi-state metro regions: a region spans cities across several states, so it
// can't be a state alias. "NCR" must include Gurgaon (Haryana) and Noida (UP),
// not just Delhi — otherwise a search for "NCR" silently misses them.
const REGIONS = {
  ncr: ['delhi', 'new delhi', 'south delhi', 'north delhi', 'gurugram', 'gurgaon', 'noida', 'greater noida', 'ghaziabad', 'faridabad'],
};
REGIONS['delhi ncr'] = REGIONS.ncr;
REGIONS['national capital region'] = REGIONS.ncr;

// Reverse maps, built once.
const STATE_TO_CITIES = {};
for (const [city, state] of Object.entries(CITY_STATE)) {
  (STATE_TO_CITIES[state] = STATE_TO_CITIES[state] || []).push(city);
}
const STATES = new Set(Object.keys(STATE_TO_CITIES));

const ALIAS_LOOKUP = {}; // any variant → full group
for (const group of ALIAS_GROUPS) {
  for (const member of group) ALIAS_LOOKUP[member] = group;
}

/**
 * Expand a free-text location into the set of substring terms to match against
 * the `city` field.
 *
 * @returns {{ isState: boolean, state: ?string, terms: string[] }}
 *   terms are lowercase substrings; a row matches if `city` ILIKE %term% for ANY.
 */
function expandLocation(text) {
  const q = normalize(text);
  if (!q) return { isState: false, state: null, terms: [] };

  // 0) Is it a multi-state metro region (NCR)? Expand to all its cities.
  if (REGIONS[q]) {
    return { isState: false, isRegion: true, state: null, terms: Array.from(new Set(REGIONS[q])) };
  }

  // 1) Is it a state (or state alias)?
  const stateName = STATES.has(q) ? q : STATE_ALIASES[q];
  if (stateName && STATE_TO_CITIES[stateName]) {
    // Match the state name itself (some rows literally say "Kerala") plus every
    // city we know to be in that state.
    const terms = new Set([stateName, ...STATE_TO_CITIES[stateName]]);
    return { isState: true, state: stateName, terms: Array.from(terms) };
  }

  // 2) Treat as a city: include its spelling variants.
  const group = ALIAS_LOOKUP[q];
  const terms = group ? Array.from(new Set([q, ...group])) : [q];
  return { isState: false, state: CITY_STATE[q] || null, terms };
}

/**
 * Tokens to fold into a founder's search_blob at sync time so free-text search
 * ("kerala", "cochin") matches even when the city field says "Kochi".
 * Returns the state and any alias variants for the given city string.
 */
function blobLocationTokens(cityRaw) {
  const q = normalize(cityRaw);
  if (!q) return [];
  const tokens = new Set();
  // Match any known city token that appears as a word/substring in the city
  // string (handles multi-city values like "kochi / kerala").
  for (const [city, state] of Object.entries(CITY_STATE)) {
    if (q.includes(city)) {
      tokens.add(state);
      const group = ALIAS_LOOKUP[city];
      if (group) group.forEach((g) => tokens.add(g));
    }
  }
  return Array.from(tokens);
}

module.exports = { normalize, expandLocation, blobLocationTokens, CITY_STATE, STATE_TO_CITIES };
