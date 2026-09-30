/** Explicit user acceptance records the user's judgment. Unreviewed evidence
 * stays unreviewed by AI after that decision. Reported weak support needs edit. */
export const USER_ACCEPTABLE_SUPPORT_STATUSES = ['fully_supports', 'unreviewed'] as const;

export function userMayAcceptSupport(supportStatus: string): boolean {
  return USER_ACCEPTABLE_SUPPORT_STATUSES.some(status => status === supportStatus);
}
