export interface Breach {
  Name: string;
  Domain?: string;
  BreachDate?: string;
}

export interface PasswordCheckResult {
  found: boolean;
  count: number;
  digits: number;
  alphabets: number;
  specialChars: number;
  length: number;
}

export interface Analytics {
  breaches: string[];
  breachesDetails: BreachDetails[];
  industries: { name: string; count: number }[];
  passwordStrength: { PlainText: number; StrongHash: number; Unknown: number };
  risk: { label: string; score: number };
  exposedData: { category: string; items: { name: string; value: number }[] }[];
  years: { year: string; count: number }[];
}

export interface BreachDetails {
  breach: string;
  xposed_date: string;
  domain: string;
  industry: string;
  xposed_data: string;
  details: string;
  references: string;
  password_risk: string;
}
