export const DEVELOPMENT_IDENTITY_PROFILE = 'development';
export const RELEASE_AUDIT_IDENTITY_PROFILE = 'release-audit';

const PROFILES = new Set([
  DEVELOPMENT_IDENTITY_PROFILE,
  RELEASE_AUDIT_IDENTITY_PROFILE,
]);

export function normalizeIdentityVerificationProfile(
  value = DEVELOPMENT_IDENTITY_PROFILE,
) {
  if (!PROFILES.has(value)) {
    const error = new TypeError(
      `identity verification profile must be ${[...PROFILES].join(' or ')}`,
    );
    error.code = 'IDENTITY_VERIFICATION_PROFILE_INVALID';
    throw error;
  }
  return value;
}

export function requiresExactIdentity(profile) {
  return normalizeIdentityVerificationProfile(profile) === RELEASE_AUDIT_IDENTITY_PROFILE;
}
