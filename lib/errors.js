// Error types shared across the whole tool.
//
// These live apart from the pipeline that throws them so that lightweight
// modules (the Spotify fetcher, for instance) can raise a user-facing error
// without importing lib/run.js and, through it, Jimp, culori and the entire
// grid pipeline. index.js checks `instanceof RunError` to decide whether to
// print a clean message or a stack trace, so a parallel error class defined
// elsewhere would silently lose that behaviour.

/** Raised for conditions the user can fix; the CLI prints these without a stack. */
export class RunError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RunError';
    }
}
