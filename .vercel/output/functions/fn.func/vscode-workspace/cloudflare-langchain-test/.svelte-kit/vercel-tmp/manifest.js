export const manifest = {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["favicon.png"]),
	mimeTypes: {".png":"image/png"},
	_: {
		client: {"start":"_app/immutable/entry/start.d6b3dd40.js","app":"_app/immutable/entry/app.eab84a1e.js","imports":["_app/immutable/entry/start.d6b3dd40.js","_app/immutable/chunks/index.ccd4248b.js","_app/immutable/chunks/singletons.8388241c.js","_app/immutable/entry/app.eab84a1e.js","_app/immutable/chunks/index.ccd4248b.js"],"stylesheets":[],"fonts":[]},
		nodes: [
			() => import('../output/server/nodes/0.js'),
			() => import('../output/server/nodes/1.js'),
			() => import('../output/server/nodes/2.js')
		],
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 2 },
				endpoint: null
			}
		],
		matchers: async () => {
			
			return {  };
		}
	}
};
