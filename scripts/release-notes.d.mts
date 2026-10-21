/**
 * Types for scripts/release-notes.mjs. The release workflow runs that file
 * directly with `node`, so it stays plain JavaScript; this declaration lets the
 * unit test import its pure helper without loosening the TypeScript settings.
 */
export function extractReleaseNotes(markdown: string, version: string): string | undefined;
