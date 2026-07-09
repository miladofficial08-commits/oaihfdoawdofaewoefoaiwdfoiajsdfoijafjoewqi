export interface VerticalPreset {
  id: string;
  label: string;
  icon: string;
  searchTerms: string[];
  offerFocus: Array<'chatbot' | 'telefon' | 'website'>;
  avgDealValue: number;
  monthlyRetainer: number;
  closeRate: number;
  whyNow: string;
  category: 'handwerk' | 'medizin' | 'recht' | 'beauty' | 'service';
}

export interface RegionPreset {
  id: string;
  label: string;
  cities: string[];
}

export const verticalPresets: VerticalPreset[] = [
  // ── HANDWERK ─────────────────────────────────────────────────────────────
  {
    id: 'shk',
    label: 'SHK – Heizung & Sanitär',
    icon: '🔧',
    searchTerms: ['SHK', 'Sanitaer Heizung', 'Heizungsbauer', 'Klempner'],
    offerFocus: ['telefon', 'website', 'chatbot'],
    avgDealValue: 4500,
    monthlyRetainer: 390,
    closeRate: 0.035,
    whyNow: 'Notdienst-Anrufe rund um die Uhr – Voice Agent übernimmt Aufnahme außerhalb der Öffnungszeiten.',
    category: 'handwerk',
  },
  {
    id: 'elektro',
    label: 'Elektriker',
    icon: '⚡',
    searchTerms: ['Elektriker', 'Elektroinstallateur', 'Elektrotechnik'],
    offerFocus: ['telefon', 'website', 'chatbot'],
    avgDealValue: 4200,
    monthlyRetainer: 390,
    closeRate: 0.032,
    whyNow: 'Notfall- und Projektanfragen brauchen schnelle Vorqualifizierung – perfekt für Voice Agent.',
    category: 'handwerk',
  },
  {
    id: 'kaelte-klima',
    label: 'Kälte & Klima',
    icon: '❄️',
    searchTerms: ['Kaelte Klima', 'Klimaanlagen', 'Kaeltetechnik'],
    offerFocus: ['telefon', 'website', 'chatbot'],
    avgDealValue: 4800,
    monthlyRetainer: 450,
    closeRate: 0.034,
    whyNow: 'Saisonale Nachfragespitzen – Voice Agent nimmt Anfragen auf wenn alle Leitungen belegt sind.',
    category: 'handwerk',
  },
  {
    id: 'kfz',
    label: 'KFZ-Werkstatt',
    icon: '🚗',
    searchTerms: ['KFZ Werkstatt', 'Autowerkstatt', 'Kfz-Meister', 'Autoservice'],
    offerFocus: ['telefon', 'chatbot'],
    avgDealValue: 3800,
    monthlyRetainer: 350,
    closeRate: 0.038,
    whyNow: 'Kunden rufen für Termine an – Voice Agent nimmt Buchungen auf und beantwortet Preis-Fragen.',
    category: 'handwerk',
  },
  // ── MEDIZIN ──────────────────────────────────────────────────────────────
  {
    id: 'arzt',
    label: 'Allgemeinarzt / Hausarzt',
    icon: '👨‍⚕️',
    searchTerms: ['Arzt', 'Hausarzt', 'Allgemeinarzt', 'Internist', 'Facharzt'],
    offerFocus: ['telefon'],
    avgDealValue: 4800,
    monthlyRetainer: 490,
    closeRate: 0.045,
    whyNow: 'Praxen sind chronisch überlastet mit Anrufen für Termine – Voice Agent nimmt 80% der Anrufe ab.',
    category: 'medizin',
  },
  {
    id: 'zahnarzt',
    label: 'Zahnarzt',
    icon: '🦷',
    searchTerms: ['Zahnarzt', 'Zahnarztpraxis', 'Zahnklinik', 'Dentist'],
    offerFocus: ['telefon', 'chatbot'],
    avgDealValue: 4200,
    monthlyRetainer: 420,
    closeRate: 0.04,
    whyNow: 'Hohe Anruffrequenz für Termine und Notfälle – Voice Agent ideal für Vorqualifizierung und Buchung.',
    category: 'medizin',
  },
  {
    id: 'kieferchirurg',
    label: 'Kieferchirurg / Kieferorthopäde',
    icon: '🏥',
    searchTerms: ['Kieferchirurg', 'Kieferorthopäde', 'Oralchirurg', 'MKG-Chirurg'],
    offerFocus: ['telefon', 'chatbot'],
    avgDealValue: 5500,
    monthlyRetainer: 550,
    closeRate: 0.038,
    whyNow: 'Spezialisierte Patientenfragen, Überweisungen und komplexe Terminplanung – Voice Agent spart Sprechzeiten.',
    category: 'medizin',
  },
  {
    id: 'physio',
    label: 'Physiotherapie',
    icon: '💪',
    searchTerms: ['Physiotherapie', 'Physiotherapeut', 'Krankengymnastik', 'Therapiezentrum'],
    offerFocus: ['telefon', 'chatbot'],
    avgDealValue: 3600,
    monthlyRetainer: 360,
    closeRate: 0.045,
    whyNow: 'Rezept-Anfragen und Terminbuchungen dominieren – Voice Agent nimmt Buchungen 24/7 entgegen.',
    category: 'medizin',
  },
  {
    id: 'tierarzt',
    label: 'Tierarzt',
    icon: '🐾',
    searchTerms: ['Tierarzt', 'Tierarztpraxis', 'Tierärztliche Klinik', 'Tiermedizin'],
    offerFocus: ['telefon', 'chatbot'],
    avgDealValue: 3800,
    monthlyRetainer: 380,
    closeRate: 0.042,
    whyNow: 'Notfälle, Impftermine, Kastration – Tierbesitzer rufen an wenn Praxis zu ist, Voice Agent fängt das auf.',
    category: 'medizin',
  },
  {
    id: 'krankenbefoerderung',
    label: 'Krankenbeförderung',
    icon: '🚐',
    searchTerms: ['Krankenbefoerderung', 'Krankentransport', 'Patientenfahrdienst'],
    offerFocus: ['telefon', 'website'],
    avgDealValue: 5500,
    monthlyRetainer: 490,
    closeRate: 0.03,
    whyNow: 'Erreichbarkeit und Terminlogik direkt umsatzrelevant – Voice Agent pflegt Buchungen ein.',
    category: 'medizin',
  },
  // ── RECHT & FINANZEN ─────────────────────────────────────────────────────
  {
    id: 'anwalt',
    label: 'Rechtsanwalt / Kanzlei',
    icon: '⚖️',
    searchTerms: ['Rechtsanwalt', 'Anwalt', 'Kanzlei', 'Rechtsanwaltskanzlei'],
    offerFocus: ['telefon', 'chatbot'],
    avgDealValue: 6000,
    monthlyRetainer: 590,
    closeRate: 0.03,
    whyNow: 'Neue Mandanten rufen an ohne Termin – Voice Agent qualifiziert vor und leitet relevante Fälle weiter.',
    category: 'recht',
  },
  {
    id: 'steuerberater',
    label: 'Steuerberater',
    icon: '📊',
    searchTerms: ['Steuerberater', 'Steuerkanzlei', 'Steuerberatung', 'Wirtschaftsprüfer'],
    offerFocus: ['telefon', 'chatbot'],
    avgDealValue: 5200,
    monthlyRetainer: 520,
    closeRate: 0.032,
    whyNow: 'Mandantenanfragen zu Fristen und Abgaben – Voice Agent beantwortet Standardfragen sofort.',
    category: 'recht',
  },
  {
    id: 'immobilien',
    label: 'Immobilienmakler',
    icon: '🏠',
    searchTerms: ['Immobilienmakler', 'Immobilien', 'Makler', 'Immobilienbüro'],
    offerFocus: ['telefon', 'chatbot', 'website'],
    avgDealValue: 7000,
    monthlyRetainer: 650,
    closeRate: 0.025,
    whyNow: 'Besichtigungsanfragen und Käuferqualifizierung – Voice Agent nimmt Interesse auf und bucht Termine.',
    category: 'recht',
  },
  // ── BEAUTY & SERVICE ─────────────────────────────────────────────────────
  {
    id: 'friseur',
    label: 'Friseursalon',
    icon: '✂️',
    searchTerms: ['Friseur', 'Friseursalon', 'Haarsalon', 'Hair Salon'],
    offerFocus: ['telefon', 'chatbot'],
    avgDealValue: 1800,
    monthlyRetainer: 190,
    closeRate: 0.065,
    whyNow: 'Terminbuchungen per Telefon sind die Norm – Voice Agent übernimmt Buchungen wenn Salon besetzt ist.',
    category: 'beauty',
  },
  {
    id: 'kosmetik',
    label: 'Kosmetikstudio / Beauty',
    icon: '💅',
    searchTerms: ['Kosmetikstudio', 'Kosmetiksalon', 'Beauty Studio', 'Kosmetikerin'],
    offerFocus: ['telefon', 'chatbot'],
    avgDealValue: 2200,
    monthlyRetainer: 220,
    closeRate: 0.06,
    whyNow: 'Behandlungstermine, Preisfragen – Voice Agent beantwortet und bucht direkt.',
    category: 'beauty',
  },
  {
    id: 'optiker',
    label: 'Optiker',
    icon: '👓',
    searchTerms: ['Optiker', 'Augenoptiker', 'Brillenstudio'],
    offerFocus: ['telefon', 'chatbot'],
    avgDealValue: 2600,
    monthlyRetainer: 260,
    closeRate: 0.052,
    whyNow: 'Sehtest-Termine und Brillen-Beratung – Voice Agent qualifiziert und bucht Termine.',
    category: 'beauty',
  },
  {
    id: 'reinigung',
    label: 'Reinigungsservice',
    icon: '🧹',
    searchTerms: ['Reinigungsservice', 'Gebäudereinigung', 'Reinigungsfirma', 'Haushaltsreinigung'],
    offerFocus: ['telefon', 'chatbot', 'website'],
    avgDealValue: 3000,
    monthlyRetainer: 290,
    closeRate: 0.048,
    whyNow: 'Angebotsanfragen dominieren – Voice Agent nimmt Details auf und leitet qualifizierte Anfragen weiter.',
    category: 'service',
  },
];

export const nrwRegions: RegionPreset[] = [
  {
    id: 'rhein-ruhr',
    label: 'Rhein-Ruhr Kern',
    cities: ['Duesseldorf', 'Koeln', 'Essen', 'Dortmund', 'Duisburg', 'Bochum', 'Wuppertal'],
  },
  {
    id: 'rheinland',
    label: 'Rheinland',
    cities: ['Koeln', 'Bonn', 'Leverkusen', 'Neuss', 'Moenchengladbach', 'Aachen'],
  },
  {
    id: 'westfalen',
    label: 'Westfalen',
    cities: ['Dortmund', 'Muenster', 'Bielefeld', 'Hamm', 'Paderborn', 'Gelsenkirchen'],
  },
];

export function getVerticalByLabel(label?: string): VerticalPreset | undefined {
  if (!label) return undefined;
  const normalized = label.toLowerCase();
  return verticalPresets.find(v =>
    v.id === normalized ||
    v.label.toLowerCase() === normalized ||
    v.searchTerms.some(term => normalized.includes(term.toLowerCase()))
  );
}
