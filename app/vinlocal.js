/* RowSkan: reads what a VIN says by itself (maker, country, model year). Works offline, for vehicles from anywhere.
 * It cannot know the model or trim - those come from the vehicle database (US) or from the lists/typing.
 * A product of LIT America (www.litamerica.net). */
(function () {
  'use strict';
  var W = { // world manufacturer identifier (first 3 characters, or 2) -> make
    JHM: 'Honda', JHL: 'Honda', JH4: 'Acura', JN1: 'Nissan', JN8: 'Nissan', JNK: 'Infiniti', JNR: 'Infiniti', JTD: 'Toyota', JTE: 'Toyota', JTH: 'Lexus', JTJ: 'Lexus', JTM: 'Toyota', JTN: 'Toyota', JT: 'Toyota',
    JF: 'Subaru', JM: 'Mazda', JS: 'Suzuki', JA: 'Mitsubishi', JY: 'Yamaha', JK: 'Kawasaki', JD: 'Daihatsu',
    '1G1': 'Chevrolet', '1GC': 'Chevrolet', '1GN': 'Chevrolet', '1GT': 'GMC', '1GK': 'GMC', '1G4': 'Buick', '1G6': 'Cadillac', '1GM': 'Pontiac', '1G2': 'Pontiac', '1GY': 'Cadillac', '1FA': 'Ford', '1FT': 'Ford', '1FM': 'Ford', '1FD': 'Ford', '1FB': 'Ford', '1FC': 'Ford', '1HG': 'Honda', '1J4': 'Jeep', '1J8': 'Jeep', '1C4': 'Chrysler', '1C3': 'Chrysler', '1C6': 'Ram', '1D7': 'Dodge', '1D3': 'Dodge', '1B3': 'Dodge', '1N4': 'Nissan', '1N6': 'Nissan', '1LN': 'Lincoln', '1ME': 'Mercury', '1VW': 'Volkswagen', '1YV': 'Mazda', '1ZV': 'Ford', '1XK': 'Kenworth', '1XP': 'Peterbilt', '1FU': 'Freightliner', '1M1': 'Mack', '1HT': 'International',
    '2HG': 'Honda', '2HK': 'Honda', '2T1': 'Toyota', '2FA': 'Ford', '2FT': 'Ford', '2G1': 'Chevrolet', '2C3': 'Chrysler', '2HM': 'Hyundai', '2A4': 'Chrysler',
    '3FA': 'Ford', '3FT': 'Ford', '3VW': 'Volkswagen', '3N1': 'Nissan', '3GN': 'Chevrolet', '3GC': 'Chevrolet', '3C4': 'Chrysler', '3C6': 'Ram', '3TM': 'Toyota', '3KP': 'Kia', '3MZ': 'Mazda', '3CZ': 'Honda',
    '4T1': 'Toyota', '4T3': 'Toyota', '4S3': 'Subaru', '4S4': 'Subaru', '4US': 'BMW', '4JG': 'Mercedes-Benz', '5YJ': 'Tesla', '7SA': 'Tesla', '7G2': 'Tesla', '5NP': 'Hyundai', '5NM': 'Hyundai', '5XY': 'Kia', '5XX': 'Kia', '5J6': 'Honda', '5FN': 'Honda', '5LM': 'Lincoln', '5UX': 'BMW', '5N1': 'Nissan', '5TD': 'Toyota', '5TF': 'Toyota', '5YF': 'Toyota', '5FR': 'Honda', '5GA': 'Buick', '5GA2': 'Buick', '7FA': 'Ford',
    KMH: 'Hyundai', KMF: 'Hyundai', KNA: 'Kia', KND: 'Kia', KNM: 'Kia', KNH: 'Kia', KPT: 'SsangYong', KL1: 'Daewoo', KLA: 'Daewoo', KMT: 'Genesis',
    WBA: 'BMW', WBS: 'BMW', WBY: 'BMW', WB1: 'BMW', WDB: 'Mercedes-Benz', WDC: 'Mercedes-Benz', WDD: 'Mercedes-Benz', WDF: 'Mercedes-Benz', W1K: 'Mercedes-Benz', W1N: 'Mercedes-Benz', W1V: 'Mercedes-Benz', W1Y: 'Mercedes-Benz', WF0: 'Ford', WVW: 'Volkswagen', WVG: 'Volkswagen', WV1: 'Volkswagen', WV2: 'Volkswagen', WAU: 'Audi', WUA: 'Audi', WP0: 'Porsche', WP1: 'Porsche', W0L: 'Opel', W0V: 'Opel', WMW: 'Mini', WME: 'Smart', WMA: 'MAN',
    VF1: 'Renault', VF3: 'Peugeot', VF7: 'Citroën', VF6: 'Renault', VR1: 'DS', VSS: 'SEAT', VWV: 'Volkswagen', ZFA: 'Fiat', ZAR: 'Alfa Romeo', ZFF: 'Ferrari', ZHW: 'Lamborghini', ZAM: 'Maserati', ZLA: 'Lancia', ZCF: 'Iveco',
    SAJ: 'Jaguar', SAL: 'Land Rover', SCC: 'Lotus', SCF: 'Aston Martin', SBM: 'McLaren', SAR: 'Rover', SAX: 'Rover', SJN: 'Nissan', SCB: 'Bentley', SCA: 'Rolls-Royce', SAH: 'Honda', SHH: 'Honda', SHS: 'Honda',
    YV1: 'Volvo', YV4: 'Volvo', YS3: 'Saab', TMB: 'Škoda', UU1: 'Dacia', NM0: 'Ford', NMT: 'Toyota', TRU: 'Audi',
    LFV: 'Volkswagen', LSV: 'Volkswagen', LVS: 'Ford', LHG: 'Honda', LGW: 'Great Wall', LB3: 'Geely', LBV: 'BMW', LSG: 'Chevrolet', LC0: 'BYD', LRW: 'Tesla', LVV: 'Chery', LJD: 'Kia', LDC: 'Dongfeng', LGB: 'Dongfeng',
    MA1: 'Mahindra', MA3: 'Suzuki', MAT: 'Tata', MAL: 'Hyundai', MBH: 'Suzuki', MBJ: 'Toyota', MHF: 'Toyota', MHR: 'Honda', MMB: 'Mitsubishi', MPA: 'Isuzu', MR0: 'Toyota', MNB: 'Ford', MRH: 'Honda', MMM: 'Chevrolet', MM8: 'Mazda',
    '6G1': 'Holden', '6FP': 'Ford', '6T1': 'Toyota', '6MM': 'Mitsubishi', '6H8': 'Holden',
    '9BW': 'Volkswagen', '9BG': 'Chevrolet', '9BD': 'Fiat', '93H': 'Honda', '9BF': 'Ford', '93Y': 'Renault', '9BR': 'Toyota', '93R': 'Toyota', '9BH': 'Hyundai'
  };
  function country(v) {
    var a = v[0], b = v[1];
    if (a === '1' || a === '4' || a === '5') return 'United States'; if (a === '2') return 'Canada'; if (a === '3') return 'Mexico';
    if (a === '6') return 'Australia'; if (a === '7') return 'New Zealand'; if (a === '8') return 'Argentina'; if (a === '9') return 'Brazil'; if (a === 'J') return 'Japan'; if (a === 'K') return 'South Korea'; if (a === 'L') return 'China';
    if (a === 'M') return b <= 'E' ? 'India' : b <= 'K' ? 'Indonesia' : b <= 'R' ? 'Thailand' : '';
    if (a === 'S') return b <= 'M' ? 'United Kingdom' : b <= 'T' ? 'Germany (former East)' : 'Poland';
    if (a === 'T') return b <= 'H' ? 'Switzerland' : b <= 'P' ? 'Czech Republic' : b <= 'V' ? 'Hungary' : 'Portugal';
    if (a === 'V') return b <= 'E' ? 'Austria' : b <= 'R' ? 'France' : 'Spain';
    if (a === 'W') return 'Germany'; if (a === 'Z') return 'Italy';
    if (a === 'X') return b <= 'M' || b === 'L' ? 'Netherlands' : 'Russia';
    if (a === 'Y') return b <= 'E' ? 'Belgium' : b <= 'K' ? 'Finland' : 'Sweden';
    if (a === 'U') return 'Romania'; if (a === 'N') return 'Turkey'; if (a === 'R') return 'Taiwan'; if (a === 'P') return 'Malaysia';
    return '';
  }
  var YC = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  function year(v) { // 10th character; the cycle repeats every 30 years (1980-2009, 2010-2039)
    var i = YC.indexOf(v[9]); if (i < 0) return '';
    var y1 = 1980 + i, y2 = y1 + 30, max = new Date().getFullYear() + 1, na = '12345'.indexOf(v[0]) >= 0;
    if (na) return String(/[A-Z]/.test(v[6]) ? y2 : y1); // North America: a letter in position 7 means 2010 or later
    return String(y2 <= max ? y2 : y1);
  }
  function decode(vin) {
    var v = String(vin || '').toUpperCase(); if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return null;
    var make = W[v.slice(0, 3)] || W[v.slice(0, 2)] || '', y = year(v), c = country(v), d = {};
    if (make) d.make = make; if (y) d.year = y; if (c) d.country = c;
    return Object.keys(d).length ? d : null;
  }
  var api = { decode: decode };
  if (typeof window !== 'undefined') window.VinLocal = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
