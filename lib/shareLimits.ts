/** The bridge of a share (files kept a few minutes on our side, between the computer and the phone). */
/** One slice of a file (well under what a server function takes in or gives back). */
export const RELAY_CHUNK = 2_000_000;
/** A share's code (random, from its QR code): what the routes accept. */
export const isShareCode = (c: unknown): c is string => typeof c === "string" && /^[A-Za-z0-9_-]{12,40}$/.test(c);
/** How long a share lasts (its QR code, the bridge, the Drive links of plan B). */
export const SHARE_MINUTES = 10;
/** Bigger shares go straight from browser to browser, or through the Drive. */
export const RELAY_MAX = 150_000_000;
