import * as server from '../entries/pages/_page.server.js';

export const index = 2;
export const component = async () => (await import('../entries/pages/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/+page.server.js";
export const imports = ["_app/immutable/nodes/2.50599010.js","_app/immutable/chunks/index.ccd4248b.js"];
export const stylesheets = [];
export const fonts = [];
