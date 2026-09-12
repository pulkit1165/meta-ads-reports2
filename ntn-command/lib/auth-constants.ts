/**
 * Values shared by the Node and Edge halves of auth.
 *
 * Kept in their own file with no imports: middleware runs on the Edge, and
 * importing these from lib/auth.ts would drag node:crypto and the pg driver
 * into the Edge bundle, which fails at build time.
 */
export const SESSION_COOKIE = 'ntn_session';
export const SESSION_HOURS = 12;
