import type { SocialKind } from "@/config/socials";

// One set of marks for every place that links a Dexvra account — /community's
// cards and the rail's quick links. Two private copies of the X path is how one
// of them ends up drawing last year's logo.
//
// "email" is the support card's own kind. It is not in SocialKind because it is
// not in SOCIALS: that list is the accounts a reader can FOLLOW, and `sameAs` on
// the Organization record is built from it — a mailto does not belong there.
export type SocialIconKind = SocialKind | "email";

// A group and a bot get their own marks: they are different things to join, and
// five identical paper planes would tell a reader nothing about which is which.
export function SocialIcon({ kind }: { kind: SocialIconKind }) {
  if (kind === "x") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.2 2h3.3l-7.2 8.3L23 22h-6.7l-5.2-6.8L5.1 22H1.8l7.7-8.8L1 2h6.8l4.7 6.2L18.2 2zm-1.2 18h1.8L7.1 3.9H5.2L17 20z" />
      </svg>
    );
  }
  if (kind === "youtube") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8zM9.7 15.1V8.9l5.8 3.1-5.8 3.1z" />
      </svg>
    );
  }
  if (kind === "group") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <circle cx="9" cy="8.5" r="3.2" />
        <path d="M2.8 19.5c1-2.9 3.3-4.3 6.2-4.3s5.2 1.4 6.2 4.3" />
        <circle cx="17" cy="7" r="2.4" />
        <path d="M17 12.2c2 .1 3.5 1.2 4.2 3.1" />
      </svg>
    );
  }
  if (kind === "email") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
        <path d="m3.8 7 8.2 6.2L20.2 7" />
      </svg>
    );
  }
  if (kind === "bot") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <rect x="4" y="8" width="16" height="11" rx="3.2" />
        <path d="M12 8V4.8M9.5 13v1.4M14.5 13v1.4M2.5 12.5v3M21.5 12.5v3" />
        <circle cx="12" cy="4" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.9 4.3 18.9 19c-.2 1-.8 1.2-1.7.8l-4.6-3.4-2.2 2.2c-.3.3-.5.4-.9.4l.3-4.7 8.5-7.7c.4-.3-.1-.5-.6-.2L7.2 12.9 2.6 11.5c-1-.3-1-1 .2-1.5l18-6.9c.8-.3 1.5.2 1.1 1.2z" />
    </svg>
  );
}
