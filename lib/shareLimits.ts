/** The bridge of a share (files kept a few minutes on our side, between the computer and the phone). */
/** One slice of a file (well under what a server function takes in or gives back). */
export const RELAY_CHUNK = 2_000_000;
/** Bigger shares go straight from browser to browser, or through the Drive. */
export const RELAY_MAX = 150_000_000;
