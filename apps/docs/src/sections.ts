/**
 * The docs' six sections, each opening its first page: in the header's
 * links where they fit, and at the top of the page list on a phone. The
 * current one is the section the page's path starts with. Experimental is
 * Weft Experimental's pages (docs/adr/0009), last, as in the page list.
 */
export const sections = [
  { label: "Start", href: "/start/what-is-weft/", prefix: "/start/" },
  { label: "Using Weft", href: "/guides/signing/", prefix: "/guides/" },
  { label: "Build a dApp", href: "/dapps/quickstart/", prefix: "/dapps/" },
  { label: "Run a network", href: "/operators/relay/", prefix: "/operators/" },
  { label: "Reference", href: "/reference/security/", prefix: "/reference/" },
  { label: "Experimental", href: "/experimental/overview/", prefix: "/experimental/" },
] as const;

/** Whether a page's path is in a section. */
export const inSection = (path: string, section: (typeof sections)[number]) => path.startsWith(section.prefix);
