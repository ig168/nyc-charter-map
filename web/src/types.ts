export type Borough = 'Manhattan' | 'Brooklyn' | 'Bronx' | 'Queens' | 'Staten Island';

/** One campus as the list and map need it (GET /api/schools). */
export interface SchoolSummary {
  id: string;
  name: string;
  network: string | null;
  borough: Borough;
  district: number | null;
  zip: string | null;
  neighborhood: string | null;
  address: string;
  lat: number;
  lng: number;
  grades: string[];
  entryGrades: string[];
  enrollment: number | null;
  yearFounded: number | null;
  deadline: string | null;
  lotteryDate: string | null;
  phone: string | null;
  sharedBuilding: boolean;
}

export interface Verification {
  confirmedBy: string[];
  geocoded: boolean;
  pinVsAddressM: number | null;
  license: { name: string; sed_code: string; authorizer: string; opened: number } | null;
  flags: string[];
  notes: string[];
}

/** Full detail (GET /api/schools/:id). */
export interface SchoolDetail extends SchoolSummary {
  officialName: string | null;
  doeCode: string | null;
  enrollmentYear: string | null;
  verification: Verification | null;
  mission: string | null;
  source: string;
  lastVerified: string;
  admissions: {
    cycle: string | null; howToApply: string | null; eligibility: string | null; lotteryPreferences: string | null;
    applicationOpen: string | null; applicationDeadline: string | null; deadlineNote: string | null;
    lotteryDate: string | null; lotteryNote: string | null; applyUrl: string | null; applyUrlLabel: string | null;
  };
  contact: { phone: string | null; email: string | null; website: string | null };
  costs: { tuitionFree: boolean; uniform: string | null; afterCare: string | null; meals: string | null; transportation: string | null };
}

export interface Filters {
  q: string;
  boroughs: Set<string>;
  levels: Set<string>;
  entry: string;
  districts: Set<number>;
  zip: string;
  savedOnly: boolean;
  inView: boolean;
  networks: Set<string>;
  places: Set<string>;
  /** miles from the chosen location; 0 = any distance */
  radius: number;
}

export interface SavedItem {
  status: string;
  note: string;
  updatedAt?: string;
}

export interface User {
  name: string;
  email: string;
  picture?: string | null;
}

export interface Origin {
  lat: number;
  lng: number;
  label: string;
  /** community school district the location falls in, when known */
  district?: number | null;
}

export type View = 'explore' | 'my';
export type Pending = { type: 'save'; id: string; source: string } | { type: 'my' } | null;
