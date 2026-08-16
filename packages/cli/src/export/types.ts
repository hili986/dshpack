import type { DoctorInput } from '../doctor/support.js';

export interface ExportInput extends Pick<DoctorInput, 'dshHome' | 'env' | 'profile'> {
  output: string;
  includePresets?: readonly string[];
  includeSettings?: boolean;
  includeSkills?: boolean;
  redact?: boolean;
  allowUnverifiedExport?: boolean;
  yes?: boolean;
}

export interface ExportReport {
  exportMode: 'minimal-whole-row' | 'opaque-profile-patch';
  integrity: 'verified' | 'unverified';
  output: string;
  profile: string;
  redactions: readonly string[];
  review: readonly string[];
  sideEffects: readonly ['profile/cordis.yml'];
}
