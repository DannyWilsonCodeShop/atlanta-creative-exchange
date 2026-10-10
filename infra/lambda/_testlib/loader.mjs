// Module-resolution hook (node:module customization API) that redirects every
// bare '@aws-sdk/*' import to the local aws-sdk-stub.mjs, so the dependency-free
// quoteHandler.mjs can be imported under `node --test` without a node_modules.
//
// Registered via `node --import ./test/loader.mjs` (see run-tests.mjs).
import { register } from 'node:module';

const stubUrl = new URL('./aws-sdk-stub.mjs', import.meta.url).href;
const hookUrl = new URL('./resolve-hook.mjs', import.meta.url).href;

register(hookUrl, { data: { stubUrl } });
