// The resolve hook that runs on the loader thread. Any specifier beginning
// with '@aws-sdk/' resolves to the stub module; everything else falls through
// to Node's default resolution.
let STUB_URL;

export async function initialize({ stubUrl }) {
    STUB_URL = stubUrl;
}

export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@aws-sdk/')) {
        return { url: STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
