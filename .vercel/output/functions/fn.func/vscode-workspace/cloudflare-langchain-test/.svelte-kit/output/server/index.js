import { b as base, a as assets, r as reset, p as public_env, o as options, g as get_hooks, s as set_public_env } from './chunks/internal.js';
import { r as readable, w as writable } from './chunks/index.js';
import { parse, serialize } from 'cookie';
import * as set_cookie_parser from 'set-cookie-parser';

const DEV = false;

/**
 * Given an Accept header and a list of possible content types, pick
 * the most suitable one to respond with
 * @param {string} accept
 * @param {string[]} types
 */
function negotiate(accept, types) {
	/** @type {Array<{ type: string, subtype: string, q: number, i: number }>} */
	const parts = [];

	accept.split(',').forEach((str, i) => {
		const match = /([^/]+)\/([^;]+)(?:;q=([0-9.]+))?/.exec(str);

		// no match equals invalid header — ignore
		if (match) {
			const [, type, subtype, q = '1'] = match;
			parts.push({ type, subtype, q: +q, i });
		}
	});

	parts.sort((a, b) => {
		if (a.q !== b.q) {
			return b.q - a.q;
		}

		if ((a.subtype === '*') !== (b.subtype === '*')) {
			return a.subtype === '*' ? 1 : -1;
		}

		if ((a.type === '*') !== (b.type === '*')) {
			return a.type === '*' ? 1 : -1;
		}

		return a.i - b.i;
	});

	let accepted;
	let min_priority = Infinity;

	for (const mimetype of types) {
		const [type, subtype] = mimetype.split('/');
		const priority = parts.findIndex(
			(part) =>
				(part.type === type || part.type === '*') &&
				(part.subtype === subtype || part.subtype === '*')
		);

		if (priority !== -1 && priority < min_priority) {
			accepted = mimetype;
			min_priority = priority;
		}
	}

	return accepted;
}

/**
 * Returns `true` if the request contains a `content-type` header with the given type
 * @param {Request} request
 * @param  {...string} types
 */
function is_content_type(request, ...types) {
	const type = request.headers.get('content-type')?.split(';', 1)[0].trim() ?? '';
	return types.includes(type.toLowerCase());
}

/**
 * @param {Request} request
 */
function is_form_content_type(request) {
	// These content types must be protected against CSRF
	// https://developer.mozilla.org/en-US/docs/Web/API/HTMLFormElement/enctype
	return is_content_type(
		request,
		'application/x-www-form-urlencoded',
		'multipart/form-data',
		'text/plain'
	);
}

let HttpError = class HttpError {
	/**
	 * @param {number} status
	 * @param {{message: string} extends App.Error ? (App.Error | string | undefined) : App.Error} body
	 */
	constructor(status, body) {
		this.status = status;
		if (typeof body === 'string') {
			this.body = { message: body };
		} else if (body) {
			this.body = body;
		} else {
			this.body = { message: `Error: ${status}` };
		}
	}

	toString() {
		return JSON.stringify(this.body);
	}
};

let Redirect = class Redirect {
	/**
	 * @param {300 | 301 | 302 | 303 | 304 | 305 | 306 | 307 | 308} status
	 * @param {string} location
	 */
	constructor(status, location) {
		this.status = status;
		this.location = location;
	}
};

/**
 * @template {Record<string, unknown> | undefined} [T=undefined]
 */
let ActionFailure = class ActionFailure {
	/**
	 * @param {number} status
	 * @param {T} [data]
	 */
	constructor(status, data) {
		this.status = status;
		this.data = data;
	}
};

// For some reason we need to type the params as well here,
// JSdoc doesn't seem to like @type with function overloads
/**
 * @type {import('@sveltejs/kit').error}
 * @param {number} status
 * @param {any} message
 */
function error(status, message) {
	if ((isNaN(status) || status < 400 || status > 599)) {
		throw new Error(`HTTP error status codes must be between 400 and 599 — ${status} is invalid`);
	}

	return new HttpError(status, message);
}

/** @type {import('@sveltejs/kit').json} */
function json(data, init) {
	// TODO deprecate this in favour of `Response.json` when it's
	// more widely supported
	const body = JSON.stringify(data);

	// we can't just do `text(JSON.stringify(data), init)` because
	// it will set a default `content-type` header. duplicated code
	// means less duplicated work
	const headers = new Headers(init?.headers);
	if (!headers.has('content-length')) {
		headers.set('content-length', encoder$3.encode(body).byteLength.toString());
	}

	if (!headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}

	return new Response(body, {
		...init,
		headers
	});
}

const encoder$3 = new TextEncoder();

/** @type {import('@sveltejs/kit').text} */
function text(body, init) {
	const headers = new Headers(init?.headers);
	if (!headers.has('content-length')) {
		headers.set('content-length', encoder$3.encode(body).byteLength.toString());
	}

	return new Response(body, {
		...init,
		headers
	});
}

/**
 * @param {unknown} err
 * @return {Error}
 */
function coalesce_to_error(err) {
	return err instanceof Error ||
		(err && /** @type {any} */ (err).name && /** @type {any} */ (err).message)
		? /** @type {Error} */ (err)
		: new Error(JSON.stringify(err));
}

/**
 * This is an identity function that exists to make TypeScript less
 * paranoid about people throwing things that aren't errors, which
 * frankly is not something we should care about
 * @param {unknown} error
 */
function normalize_error(error) {
	return /** @type {Redirect | HttpError | Error} */ (error);
}

/**
 * @param {Partial<Record<import('types').HttpMethod, any>>} mod
 * @param {import('types').HttpMethod} method
 */
function method_not_allowed(mod, method) {
	return text(`${method} method not allowed`, {
		status: 405,
		headers: {
			// https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/405
			// "The server must generate an Allow header field in a 405 status code response"
			allow: allowed_methods(mod).join(', ')
		}
	});
}

/** @param {Partial<Record<import('types').HttpMethod, any>>} mod */
function allowed_methods(mod) {
	const allowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].filter(
		(method) => method in mod
	);

	if ('GET' in mod || 'HEAD' in mod) allowed.push('HEAD');

	return allowed;
}

/**
 * Return as a response that renders the error.html
 *
 * @param {import('types').SSROptions} options
 * @param {number} status
 * @param {string} message
 */
function static_error_page(options, status, message) {
	let page = options.templates.error({ status, message });

	return text(page, {
		headers: { 'content-type': 'text/html; charset=utf-8' },
		status
	});
}

/**
 * @param {import('types').RequestEvent} event
 * @param {import('types').SSROptions} options
 * @param {unknown} error
 */
async function handle_fatal_error(event, options, error) {
	error = error instanceof HttpError ? error : coalesce_to_error(error);
	const status = error instanceof HttpError ? error.status : 500;
	const body = await handle_error_and_jsonify(event, options, error);

	// ideally we'd use sec-fetch-dest instead, but Safari — quelle surprise — doesn't support it
	const type = negotiate(event.request.headers.get('accept') || 'text/html', [
		'application/json',
		'text/html'
	]);

	if (event.isDataRequest || type === 'application/json') {
		return json(body, {
			status
		});
	}

	return static_error_page(options, status, body.message);
}

/**
 * @param {import('types').RequestEvent} event
 * @param {import('types').SSROptions} options
 * @param {any} error
 * @returns {Promise<App.Error>}
 */
async function handle_error_and_jsonify(event, options, error) {
	if (error instanceof HttpError) {
		return error.body;
	} else {

		return (
			(await options.hooks.handleError({ error, event })) ?? {
				message: event.route.id != null ? 'Internal Error' : 'Not Found'
			}
		);
	}
}

/**
 * @param {number} status
 * @param {string} location
 */
function redirect_response(status, location) {
	const response = new Response(undefined, {
		status,
		headers: { location }
	});
	return response;
}

/**
 * @param {import('types').RequestEvent} event
 * @param {Error & { path: string }} error
 */
function clarify_devalue_error(event, error) {
	if (error.path) {
		return `Data returned from \`load\` while rendering ${event.route.id} is not serializable: ${error.message} (data${error.path})`;
	}

	if (error.path === '') {
		return `Data returned from \`load\` while rendering ${event.route.id} is not a plain object`;
	}

	// belt and braces — this should never happen
	return error.message;
}

/**
 * @param {import('types').ServerDataNode} node
 */
function stringify_uses(node) {
	const uses = [];

	if (node.uses && node.uses.dependencies.size > 0) {
		uses.push(`"dependencies":${JSON.stringify(Array.from(node.uses.dependencies))}`);
	}

	if (node.uses && node.uses.params.size > 0) {
		uses.push(`"params":${JSON.stringify(Array.from(node.uses.params))}`);
	}

	if (node.uses?.parent) uses.push(`"parent":1`);
	if (node.uses?.route) uses.push(`"route":1`);
	if (node.uses?.url) uses.push(`"url":1`);

	return `"uses":{${uses.join(',')}}`;
}

/**
 * @param {import('types').RequestEvent} event
 * @param {import('types').SSREndpoint} mod
 * @param {import('types').SSRState} state
 * @returns {Promise<Response>}
 */
async function render_endpoint(event, mod, state) {
	const method = /** @type {import('types').HttpMethod} */ (event.request.method);

	let handler = mod[method];

	if (!handler && method === 'HEAD') {
		handler = mod.GET;
	}

	if (!handler) {
		return method_not_allowed(mod, method);
	}

	const prerender = mod.prerender ?? state.prerender_default;

	if (prerender && (mod.POST || mod.PATCH || mod.PUT || mod.DELETE)) {
		throw new Error('Cannot prerender endpoints that have mutative methods');
	}

	if (state.prerendering && !prerender) {
		if (state.depth > 0) {
			// if request came from a prerendered page, bail
			throw new Error(`${event.route.id} is not prerenderable`);
		} else {
			// if request came direct from the crawler, signal that
			// this route cannot be prerendered, but don't bail
			return new Response(undefined, { status: 204 });
		}
	}

	try {
		const response = await handler(
			/** @type {import('types').RequestEvent<Record<string, any>>} */ (event)
		);

		if (!(response instanceof Response)) {
			throw new Error(
				`Invalid response from route ${event.url.pathname}: handler should return a Response object`
			);
		}

		if (state.prerendering) {
			response.headers.set('x-sveltekit-prerender', String(prerender));
		}

		return response;
	} catch (e) {
		if (e instanceof Redirect) {
			return new Response(undefined, {
				status: e.status,
				headers: { location: e.location }
			});
		}

		throw e;
	}
}

/**
 * @param {import('types').RequestEvent} event
 */
function is_endpoint_request(event) {
	const { method, headers } = event.request;

	if (method === 'PUT' || method === 'PATCH' || method === 'DELETE' || method === 'OPTIONS') {
		// These methods exist exclusively for endpoints
		return true;
	}

	// use:enhance uses a custom header to disambiguate
	if (method === 'POST' && headers.get('x-sveltekit-action') === 'true') return false;

	// GET/POST requests may be for endpoints or pages. We prefer endpoints if this isn't a text/html request
	const accept = event.request.headers.get('accept') ?? '*/*';
	return negotiate(accept, ['*', 'text/html']) !== 'text/html';
}

/**
 * Removes nullish values from an array.
 *
 * @template T
 * @param {Array<T>} arr
 */
function compact(arr) {
	return arr.filter(/** @returns {val is NonNullable<T>} */ (val) => val != null);
}

/**
 * @param {string} path
 * @param {import('types').TrailingSlash} trailing_slash
 */
function normalize_path(path, trailing_slash) {
	if (path === '/' || trailing_slash === 'ignore') return path;

	if (trailing_slash === 'never') {
		return path.endsWith('/') ? path.slice(0, -1) : path;
	} else if (trailing_slash === 'always' && !path.endsWith('/')) {
		return path + '/';
	}

	return path;
}

/**
 * Decode pathname excluding %25 to prevent further double decoding of params
 * @param {string} pathname
 */
function decode_pathname(pathname) {
	return pathname.split('%25').map(decodeURI).join('%25');
}

/** @param {Record<string, string>} params */
function decode_params(params) {
	for (const key in params) {
		// input has already been decoded by decodeURI
		// now handle the rest
		params[key] = decodeURIComponent(params[key]);
	}

	return params;
}

/**
 * URL properties that could change during the lifetime of the page,
 * which excludes things like `origin`
 */
const tracked_url_properties = /** @type {const} */ ([
	'href',
	'pathname',
	'search',
	'searchParams',
	'toString',
	'toJSON'
]);

/**
 * @param {URL} url
 * @param {() => void} callback
 */
function make_trackable(url, callback) {
	const tracked = new URL(url);

	for (const property of tracked_url_properties) {
		Object.defineProperty(tracked, property, {
			get() {
				callback();
				return url[property];
			},

			enumerable: true,
			configurable: true
		});
	}

	{
		// @ts-ignore
		tracked[Symbol.for('nodejs.util.inspect.custom')] = (depth, opts, inspect) => {
			return inspect(url, opts);
		};
	}

	disable_hash(tracked);

	return tracked;
}

/**
 * Disallow access to `url.hash` on the server and in `load`
 * @param {URL} url
 */
function disable_hash(url) {
	Object.defineProperty(url, 'hash', {
		get() {
			throw new Error(
				'Cannot access event.url.hash. Consider using `$page.url.hash` inside a component instead'
			);
		}
	});
}

/**
 * Disallow access to `url.search` and `url.searchParams` during prerendering
 * @param {URL} url
 */
function disable_search(url) {
	for (const property of ['search', 'searchParams']) {
		Object.defineProperty(url, property, {
			get() {
				throw new Error(`Cannot access url.${property} on a page with prerendering enabled`);
			}
		});
	}
}

const DATA_SUFFIX = '/__data.json';

/** @param {string} pathname */
function has_data_suffix(pathname) {
	return pathname.endsWith(DATA_SUFFIX);
}

/** @param {string} pathname */
function add_data_suffix(pathname) {
	return pathname.replace(/\/$/, '') + DATA_SUFFIX;
}

/** @param {string} pathname */
function strip_data_suffix(pathname) {
	return pathname.slice(0, -DATA_SUFFIX.length);
}

/** @type {Record<string, string>} */
const escaped = {
	'<': '\\u003C',
	'>': '\\u003E',
	'/': '\\u002F',
	'\\': '\\\\',
	'\b': '\\b',
	'\f': '\\f',
	'\n': '\\n',
	'\r': '\\r',
	'\t': '\\t',
	'\0': '\\u0000',
	'\u2028': '\\u2028',
	'\u2029': '\\u2029'
};

class DevalueError extends Error {
	/**
	 * @param {string} message
	 * @param {string[]} keys
	 */
	constructor(message, keys) {
		super(message);
		this.name = 'DevalueError';
		this.path = keys.join('');
	}
}

/** @param {any} thing */
function is_primitive(thing) {
	return Object(thing) !== thing;
}

const object_proto_names = Object.getOwnPropertyNames(Object.prototype)
	.sort()
	.join('\0');

/** @param {any} thing */
function is_plain_object(thing) {
	const proto = Object.getPrototypeOf(thing);

	return (
		proto === Object.prototype ||
		proto === null ||
		Object.getOwnPropertyNames(proto).sort().join('\0') === object_proto_names
	);
}

/** @param {any} thing */
function get_type(thing) {
	return Object.prototype.toString.call(thing).slice(8, -1);
}

/** @param {string} str */
function stringify_string(str) {
	let result = '"';

	for (let i = 0; i < str.length; i += 1) {
		const char = str.charAt(i);
		const code = char.charCodeAt(0);

		if (char === '"') {
			result += '\\"';
		} else if (char in escaped) {
			result += escaped[char];
		} else if (code <= 0x001F) {
			result += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
		} else if (code >= 0xd800 && code <= 0xdfff) {
			const next = str.charCodeAt(i + 1);

			// If this is the beginning of a [high, low] surrogate pair,
			// add the next two characters, otherwise escape
			if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
				result += char + str[++i];
			} else {
				result += `\\u${code.toString(16).toUpperCase()}`;
			}
		} else {
			result += char;
		}
	}

	result += '"';
	return result;
}

const chars$1 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
const unsafe_chars = /[<>\b\f\n\r\t\0\u2028\u2029]/g;
const reserved =
	/^(?:do|if|in|for|int|let|new|try|var|byte|case|char|else|enum|goto|long|this|void|with|await|break|catch|class|const|final|float|short|super|throw|while|yield|delete|double|export|import|native|return|switch|throws|typeof|boolean|default|extends|finally|package|private|abstract|continue|debugger|function|volatile|interface|protected|transient|implements|instanceof|synchronized)$/;

/**
 * Turn a value into the JavaScript that creates an equivalent value
 * @param {any} value
 * @param {(value: any) => string | void} [replacer]
 */
function uneval(value, replacer) {
	const counts = new Map();

	/** @type {string[]} */
	const keys = [];

	const custom = new Map();

	/** @param {any} thing */
	function walk(thing) {
		if (typeof thing === 'function') {
			throw new DevalueError(`Cannot stringify a function`, keys);
		}

		if (!is_primitive(thing)) {
			if (counts.has(thing)) {
				counts.set(thing, counts.get(thing) + 1);
				return;
			}

			counts.set(thing, 1);

			if (replacer) {
				const str = replacer(thing);

				if (typeof str === 'string') {
					custom.set(thing, str);
					return;
				}
			}

			const type = get_type(thing);

			switch (type) {
				case 'Number':
				case 'BigInt':
				case 'String':
				case 'Boolean':
				case 'Date':
				case 'RegExp':
					return;

				case 'Array':
					/** @type {any[]} */ (thing).forEach((value, i) => {
						keys.push(`[${i}]`);
						walk(value);
						keys.pop();
					});
					break;

				case 'Set':
					Array.from(thing).forEach(walk);
					break;

				case 'Map':
					for (const [key, value] of thing) {
						keys.push(
							`.get(${is_primitive(key) ? stringify_primitive$1(key) : '...'})`
						);
						walk(value);
						keys.pop();
					}
					break;

				default:
					if (!is_plain_object(thing)) {
						throw new DevalueError(
							`Cannot stringify arbitrary non-POJOs`,
							keys
						);
					}

					if (Object.getOwnPropertySymbols(thing).length > 0) {
						throw new DevalueError(
							`Cannot stringify POJOs with symbolic keys`,
							keys
						);
					}

					for (const key in thing) {
						keys.push(`.${key}`);
						walk(thing[key]);
						keys.pop();
					}
			}
		}
	}

	walk(value);

	const names = new Map();

	Array.from(counts)
		.filter((entry) => entry[1] > 1)
		.sort((a, b) => b[1] - a[1])
		.forEach((entry, i) => {
			names.set(entry[0], get_name(i));
		});

	/**
	 * @param {any} thing
	 * @returns {string}
	 */
	function stringify(thing) {
		if (names.has(thing)) {
			return names.get(thing);
		}

		if (is_primitive(thing)) {
			return stringify_primitive$1(thing);
		}

		if (custom.has(thing)) {
			return custom.get(thing);
		}

		const type = get_type(thing);

		switch (type) {
			case 'Number':
			case 'String':
			case 'Boolean':
				return `Object(${stringify(thing.valueOf())})`;

			case 'RegExp':
				return `new RegExp(${stringify_string(thing.source)}, "${
					thing.flags
				}")`;

			case 'Date':
				return `new Date(${thing.getTime()})`;

			case 'Array':
				const members = /** @type {any[]} */ (thing).map((v, i) =>
					i in thing ? stringify(v) : ''
				);
				const tail = thing.length === 0 || thing.length - 1 in thing ? '' : ',';
				return `[${members.join(',')}${tail}]`;

			case 'Set':
			case 'Map':
				return `new ${type}([${Array.from(thing).map(stringify).join(',')}])`;

			default:
				const obj = `{${Object.keys(thing)
					.map((key) => `${safe_key(key)}:${stringify(thing[key])}`)
					.join(',')}}`;
				const proto = Object.getPrototypeOf(thing);
				if (proto === null) {
					return Object.keys(thing).length > 0
						? `Object.assign(Object.create(null),${obj})`
						: `Object.create(null)`;
				}

				return obj;
		}
	}

	const str = stringify(value);

	if (names.size) {
		/** @type {string[]} */
		const params = [];

		/** @type {string[]} */
		const statements = [];

		/** @type {string[]} */
		const values = [];

		names.forEach((name, thing) => {
			params.push(name);

			if (custom.has(thing)) {
				values.push(/** @type {string} */ (custom.get(thing)));
				return;
			}

			if (is_primitive(thing)) {
				values.push(stringify_primitive$1(thing));
				return;
			}

			const type = get_type(thing);

			switch (type) {
				case 'Number':
				case 'String':
				case 'Boolean':
					values.push(`Object(${stringify(thing.valueOf())})`);
					break;

				case 'RegExp':
					values.push(thing.toString());
					break;

				case 'Date':
					values.push(`new Date(${thing.getTime()})`);
					break;

				case 'Array':
					values.push(`Array(${thing.length})`);
					/** @type {any[]} */ (thing).forEach((v, i) => {
						statements.push(`${name}[${i}]=${stringify(v)}`);
					});
					break;

				case 'Set':
					values.push(`new Set`);
					statements.push(
						`${name}.${Array.from(thing)
							.map((v) => `add(${stringify(v)})`)
							.join('.')}`
					);
					break;

				case 'Map':
					values.push(`new Map`);
					statements.push(
						`${name}.${Array.from(thing)
							.map(([k, v]) => `set(${stringify(k)}, ${stringify(v)})`)
							.join('.')}`
					);
					break;

				default:
					values.push(
						Object.getPrototypeOf(thing) === null ? 'Object.create(null)' : '{}'
					);
					Object.keys(thing).forEach((key) => {
						statements.push(
							`${name}${safe_prop(key)}=${stringify(thing[key])}`
						);
					});
			}
		});

		statements.push(`return ${str}`);

		return `(function(${params.join(',')}){${statements.join(
			';'
		)}}(${values.join(',')}))`;
	} else {
		return str;
	}
}

/** @param {number} num */
function get_name(num) {
	let name = '';

	do {
		name = chars$1[num % chars$1.length] + name;
		num = ~~(num / chars$1.length) - 1;
	} while (num >= 0);

	return reserved.test(name) ? `${name}0` : name;
}

/** @param {string} c */
function escape_unsafe_char(c) {
	return escaped[c] || c;
}

/** @param {string} str */
function escape_unsafe_chars(str) {
	return str.replace(unsafe_chars, escape_unsafe_char);
}

/** @param {string} key */
function safe_key(key) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key)
		? key
		: escape_unsafe_chars(JSON.stringify(key));
}

/** @param {string} key */
function safe_prop(key) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key)
		? `.${key}`
		: `[${escape_unsafe_chars(JSON.stringify(key))}]`;
}

/** @param {any} thing */
function stringify_primitive$1(thing) {
	if (typeof thing === 'string') return stringify_string(thing);
	if (thing === void 0) return 'void 0';
	if (thing === 0 && 1 / thing < 0) return '-0';
	const str = String(thing);
	if (typeof thing === 'number') return str.replace(/^(-)?0\./, '$1.');
	if (typeof thing === 'bigint') return thing + 'n';
	return str;
}

const UNDEFINED = -1;
const HOLE = -2;
const NAN = -3;
const POSITIVE_INFINITY = -4;
const NEGATIVE_INFINITY = -5;
const NEGATIVE_ZERO = -6;

/**
 * Turn a value into a JSON string that can be parsed with `devalue.parse`
 * @param {any} value
 * @param {Record<string, (value: any) => any>} [reducers]
 */
function stringify(value, reducers) {
	/** @type {any[]} */
	const stringified = [];

	/** @type {Map<any, number>} */
	const indexes = new Map();

	/** @type {Array<{ key: string, fn: (value: any) => any }>} */
	const custom = [];
	for (const key in reducers) {
		custom.push({ key, fn: reducers[key] });
	}

	/** @type {string[]} */
	const keys = [];

	let p = 0;

	/** @param {any} thing */
	function flatten(thing) {
		if (typeof thing === 'function') {
			throw new DevalueError(`Cannot stringify a function`, keys);
		}

		if (indexes.has(thing)) return indexes.get(thing);

		if (thing === undefined) return UNDEFINED;
		if (Number.isNaN(thing)) return NAN;
		if (thing === Infinity) return POSITIVE_INFINITY;
		if (thing === -Infinity) return NEGATIVE_INFINITY;
		if (thing === 0 && 1 / thing < 0) return NEGATIVE_ZERO;

		const index = p++;
		indexes.set(thing, index);

		for (const { key, fn } of custom) {
			const value = fn(thing);
			if (value) {
				stringified[index] = `["${key}",${flatten(value)}]`;
				return index;
			}
		}

		let str = '';

		if (is_primitive(thing)) {
			str = stringify_primitive(thing);
		} else {
			const type = get_type(thing);

			switch (type) {
				case 'Number':
				case 'String':
				case 'Boolean':
					str = `["Object",${stringify_primitive(thing)}]`;
					break;

				case 'BigInt':
					str = `["BigInt",${thing}]`;
					break;

				case 'Date':
					str = `["Date","${thing.toISOString()}"]`;
					break;

				case 'RegExp':
					const { source, flags } = thing;
					str = flags
						? `["RegExp",${stringify_string(source)},"${flags}"]`
						: `["RegExp",${stringify_string(source)}]`;
					break;

				case 'Array':
					str = '[';

					for (let i = 0; i < thing.length; i += 1) {
						if (i > 0) str += ',';

						if (i in thing) {
							keys.push(`[${i}]`);
							str += flatten(thing[i]);
							keys.pop();
						} else {
							str += HOLE;
						}
					}

					str += ']';

					break;

				case 'Set':
					str = '["Set"';

					for (const value of thing) {
						str += `,${flatten(value)}`;
					}

					str += ']';
					break;

				case 'Map':
					str = '["Map"';

					for (const [key, value] of thing) {
						keys.push(
							`.get(${is_primitive(key) ? stringify_primitive(key) : '...'})`
						);
						str += `,${flatten(key)},${flatten(value)}`;
					}

					str += ']';
					break;

				default:
					if (!is_plain_object(thing)) {
						throw new DevalueError(
							`Cannot stringify arbitrary non-POJOs`,
							keys
						);
					}

					if (Object.getOwnPropertySymbols(thing).length > 0) {
						throw new DevalueError(
							`Cannot stringify POJOs with symbolic keys`,
							keys
						);
					}

					if (Object.getPrototypeOf(thing) === null) {
						str = '["null"';
						for (const key in thing) {
							keys.push(`.${key}`);
							str += `,${stringify_string(key)},${flatten(thing[key])}`;
							keys.pop();
						}
						str += ']';
					} else {
						str = '{';
						let started = false;
						for (const key in thing) {
							if (started) str += ',';
							started = true;
							keys.push(`.${key}`);
							str += `${stringify_string(key)}:${flatten(thing[key])}`;
							keys.pop();
						}
						str += '}';
					}
			}
		}

		stringified[index] = str;
		return index;
	}

	const index = flatten(value);

	// special case — value is represented as a negative index
	if (index < 0) return `${index}`;

	return `[${stringified.join(',')}]`;
}

/**
 * @param {any} thing
 * @returns {string}
 */
function stringify_primitive(thing) {
	const type = typeof thing;
	if (type === 'string') return stringify_string(thing);
	if (thing instanceof String) return stringify_string(thing.toString());
	if (thing === void 0) return UNDEFINED.toString();
	if (thing === 0 && 1 / thing < 0) return NEGATIVE_ZERO.toString();
	if (type === 'bigint') return `["BigInt","${thing}"]`;
	return String(thing);
}

/** @param {import('types').RequestEvent} event */
function is_action_json_request(event) {
	const accept = negotiate(event.request.headers.get('accept') ?? '*/*', [
		'application/json',
		'text/html'
	]);

	return accept === 'application/json' && event.request.method === 'POST';
}

/**
 * @param {import('types').RequestEvent} event
 * @param {import('types').SSROptions} options
 * @param {import('types').SSRNode['server'] | undefined} server
 */
async function handle_action_json_request(event, options, server) {
	const actions = server?.actions;

	if (!actions) {
		// TODO should this be a different error altogether?
		const no_actions_error = error(405, 'POST method not allowed. No actions exist for this page');
		return action_json(
			{
				type: 'error',
				error: await handle_error_and_jsonify(event, options, no_actions_error)
			},
			{
				status: no_actions_error.status,
				headers: {
					// https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/405
					// "The server must generate an Allow header field in a 405 status code response"
					allow: 'GET'
				}
			}
		);
	}

	check_named_default_separate(actions);

	try {
		const data = await call_action(event, actions);

		if (false) ;

		if (data instanceof ActionFailure) {
			return action_json({
				type: 'failure',
				status: data.status,
				// @ts-expect-error we assign a string to what is supposed to be an object. That's ok
				// because we don't use the object outside, and this way we have better code navigation
				// through knowing where the related interface is used.
				data: stringify_action_response(data.data, /** @type {string} */ (event.route.id))
			});
		} else {
			return action_json({
				type: 'success',
				status: data ? 200 : 204,
				// @ts-expect-error see comment above
				data: stringify_action_response(data, /** @type {string} */ (event.route.id))
			});
		}
	} catch (e) {
		const err = normalize_error(e);

		if (err instanceof Redirect) {
			return action_json_redirect(err);
		}

		return action_json(
			{
				type: 'error',
				error: await handle_error_and_jsonify(event, options, check_incorrect_fail_use(err))
			},
			{
				status: err instanceof HttpError ? err.status : 500
			}
		);
	}
}

/**
 * @param {HttpError | Error} error
 */
function check_incorrect_fail_use(error) {
	return error instanceof ActionFailure
		? new Error(`Cannot "throw fail()". Use "return fail()"`)
		: error;
}

/**
 * @param {import('types').Redirect} redirect
 */
function action_json_redirect(redirect) {
	return action_json({
		type: 'redirect',
		status: redirect.status,
		location: redirect.location
	});
}

/**
 * @param {import('types').ActionResult} data
 * @param {ResponseInit} [init]
 */
function action_json(data, init) {
	return json(data, init);
}

/**
 * @param {import('types').RequestEvent} event
 */
function is_action_request(event) {
	return event.request.method === 'POST';
}

/**
 * @param {import('types').RequestEvent} event
 * @param {import('types').SSRNode['server'] | undefined} server
 * @returns {Promise<import('types').ActionResult>}
 */
async function handle_action_request(event, server) {
	const actions = server?.actions;

	if (!actions) {
		// TODO should this be a different error altogether?
		event.setHeaders({
			// https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/405
			// "The server must generate an Allow header field in a 405 status code response"
			allow: 'GET'
		});
		return {
			type: 'error',
			error: error(405, 'POST method not allowed. No actions exist for this page')
		};
	}

	check_named_default_separate(actions);

	try {
		const data = await call_action(event, actions);

		if (false) ;

		if (data instanceof ActionFailure) {
			return {
				type: 'failure',
				status: data.status,
				data: data.data
			};
		} else {
			return {
				type: 'success',
				status: 200,
				// @ts-expect-error this will be removed upon serialization, so `undefined` is the same as omission
				data
			};
		}
	} catch (e) {
		const err = normalize_error(e);

		if (err instanceof Redirect) {
			return {
				type: 'redirect',
				status: err.status,
				location: err.location
			};
		}

		return {
			type: 'error',
			error: check_incorrect_fail_use(err)
		};
	}
}

/**
 * @param {import('types').Actions} actions
 */
function check_named_default_separate(actions) {
	if (actions.default && Object.keys(actions).length > 1) {
		throw new Error(
			`When using named actions, the default action cannot be used. See the docs for more info: https://kit.svelte.dev/docs/form-actions#named-actions`
		);
	}
}

/**
 * @param {import('types').RequestEvent} event
 * @param {NonNullable<import('types').SSRNode['server']['actions']>} actions
 * @throws {Redirect | ActionFailure | HttpError | Error}
 */
async function call_action(event, actions) {
	const url = new URL(event.request.url);

	let name = 'default';
	for (const param of url.searchParams) {
		if (param[0].startsWith('/')) {
			name = param[0].slice(1);
			if (name === 'default') {
				throw new Error('Cannot use reserved action name "default"');
			}
			break;
		}
	}

	const action = actions[name];
	if (!action) {
		throw new Error(`No action with name '${name}' found`);
	}

	if (!is_form_content_type(event.request)) {
		throw new Error(
			`Actions expect form-encoded data (received ${event.request.headers.get('content-type')})`
		);
	}

	return action(event);
}

/** @param {any} data */
function validate_action_return(data) {
	if (data instanceof Redirect) {
		throw new Error(`Cannot \`return redirect(...)\` — use \`throw redirect(...)\` instead`);
	}

	if (data instanceof HttpError) {
		throw new Error(
			`Cannot \`return error(...)\` — use \`throw error(...)\` or \`return fail(...)\` instead`
		);
	}
}

/**
 * Try to `devalue.uneval` the data object, and if it fails, return a proper Error with context
 * @param {any} data
 * @param {string} route_id
 */
function uneval_action_response(data, route_id) {
	return try_deserialize(data, uneval, route_id);
}

/**
 * Try to `devalue.stringify` the data object, and if it fails, return a proper Error with context
 * @param {any} data
 * @param {string} route_id
 */
function stringify_action_response(data, route_id) {
	return try_deserialize(data, stringify, route_id);
}

/**
 * @param {any} data
 * @param {(data: any) => string} fn
 * @param {string} route_id
 */
function try_deserialize(data, fn, route_id) {
	try {
		return fn(data);
	} catch (e) {
		// If we're here, the data could not be serialized with devalue
		const error = /** @type {any} */ (e);

		if ('path' in error) {
			let message = `Data returned from action inside ${route_id} is not serializable: ${error.message}`;
			if (error.path !== '') message += ` (data.${error.path})`;
			throw new Error(message);
		}

		throw error;
	}
}

/**
 * Given an object, return a new object where all top level values are awaited
 *
 * @param {Record<string, any>} object
 * @returns {Promise<Record<string, any>>}
 */
async function unwrap_promises(object) {
	for (const key in object) {
		if (typeof object[key]?.then === 'function') {
			return Object.fromEntries(
				await Promise.all(Object.entries(object).map(async ([key, value]) => [key, await value]))
			);
		}
	}

	return object;
}

/**
 * @param {string} route_id
 * @param {string} dep
 */

const INVALIDATED_PARAM = 'x-sveltekit-invalidated';

/**
 * Calls the user's server `load` function.
 * @param {{
 *   event: import('types').RequestEvent;
 *   state: import('types').SSRState;
 *   node: import('types').SSRNode | undefined;
 *   parent: () => Promise<Record<string, any>>;
 * }} opts
 * @returns {Promise<import('types').ServerDataNode | null>}
 */
async function load_server_data({ event, state, node, parent }) {
	if (!node?.server) return null;

	const uses = {
		dependencies: new Set(),
		params: new Set(),
		parent: false,
		route: false,
		url: false
	};

	const url = make_trackable(event.url, () => {

		uses.url = true;
	});

	if (state.prerendering) {
		disable_search(url);
	}

	const result = await node.server.load?.call(null, {
		...event,
		fetch: (info, init) => {
			const url = new URL(info instanceof Request ? info.url : info, event.url);

			uses.dependencies.add(url.href);

			return event.fetch(info, init);
		},
		/** @param {string[]} deps */
		depends: (...deps) => {
			for (const dep of deps) {
				const { href } = new URL(dep, event.url);

				uses.dependencies.add(href);
			}
		},
		params: new Proxy(event.params, {
			get: (target, key) => {

				uses.params.add(key);
				return target[/** @type {string} */ (key)];
			}
		}),
		parent: async () => {

			uses.parent = true;
			return parent();
		},
		route: new Proxy(event.route, {
			get: (target, key) => {

				uses.route = true;
				return target[/** @type {'id'} */ (key)];
			}
		}),
		url
	});

	const data = result ? await unwrap_promises(result) : null;

	return {
		type: 'data',
		data,
		uses,
		slash: node.server.trailingSlash
	};
}

/**
 * Calls the user's `load` function.
 * @param {{
 *   event: import('types').RequestEvent;
 *   fetched: import('./types').Fetched[];
 *   node: import('types').SSRNode | undefined;
 *   parent: () => Promise<Record<string, any>>;
 *   resolve_opts: import('types').RequiredResolveOptions;
 *   server_data_promise: Promise<import('types').ServerDataNode | null>;
 *   state: import('types').SSRState;
 *   csr: boolean;
 * }} opts
 * @returns {Promise<Record<string, any | Promise<any>> | null>}
 */
async function load_data({
	event,
	fetched,
	node,
	parent,
	server_data_promise,
	state,
	resolve_opts,
	csr
}) {
	const server_data_node = await server_data_promise;

	if (!node?.universal?.load) {
		return server_data_node?.data ?? null;
	}

	const result = await node.universal.load.call(null, {
		url: event.url,
		params: event.params,
		data: server_data_node?.data ?? null,
		route: event.route,
		fetch: create_universal_fetch(event, state, fetched, csr, resolve_opts),
		setHeaders: event.setHeaders,
		depends: () => {},
		parent
	});

	const data = result ? await unwrap_promises(result) : null;

	return data;
}

/**
 * @param {Pick<import('types').RequestEvent, 'fetch' | 'url' | 'request' | 'route'>} event
 * @param {import("types").SSRState} state
 * @param {import("./types").Fetched[]} fetched
 * @param {boolean} csr
 * @param {Pick<Required<import("types").ResolveOptions>, 'filterSerializedResponseHeaders'>} resolve_opts
 */
function create_universal_fetch(event, state, fetched, csr, resolve_opts) {
	/**
	 * @param {URL | RequestInfo} input
	 * @param {RequestInit} [init]
	 */
	return async (input, init) => {
		const cloned_body = input instanceof Request && input.body ? input.clone().body : null;
		let response = await event.fetch(input, init);

		const url = new URL(input instanceof Request ? input.url : input, event.url);
		const same_origin = url.origin === event.url.origin;

		/** @type {import('types').PrerenderDependency} */
		let dependency;

		if (same_origin) {
			if (state.prerendering) {
				dependency = { response, body: null };
				state.prerendering.dependencies.set(url.pathname, dependency);
			}
		} else {
			// simulate CORS errors and "no access to body in no-cors mode" server-side for consistency with client-side behaviour
			const mode = input instanceof Request ? input.mode : init?.mode ?? 'cors';
			if (mode === 'no-cors') {
				response = new Response('', {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers
				});
			} else {
				const acao = response.headers.get('access-control-allow-origin');
				if (!acao || (acao !== event.url.origin && acao !== '*')) {
					throw new Error(
						`CORS error: ${
							acao ? 'Incorrect' : 'No'
						} 'Access-Control-Allow-Origin' header is present on the requested resource`
					);
				}
			}
		}

		const proxy = new Proxy(response, {
			get(response, key, _receiver) {
				async function text() {
					const body = await response.text();

					if (!body || typeof body === 'string') {
						const status_number = Number(response.status);
						if (isNaN(status_number)) {
							throw new Error(
								`response.status is not a number. value: "${
									response.status
								}" type: ${typeof response.status}`
							);
						}

						fetched.push({
							url: same_origin ? url.href.slice(event.url.origin.length) : url.href,
							method: event.request.method,
							request_body: /** @type {string | ArrayBufferView | undefined} */ (
								input instanceof Request && cloned_body
									? await stream_to_string(cloned_body)
									: init?.body
							),
							request_headers: init?.headers,
							response_body: body,
							response: response
						});
					}

					if (dependency) {
						dependency.body = body;
					}

					return body;
				}

				if (key === 'arrayBuffer') {
					return async () => {
						const buffer = await response.arrayBuffer();

						if (dependency) {
							dependency.body = new Uint8Array(buffer);
						}

						// TODO should buffer be inlined into the page (albeit base64'd)?
						// any conditions in which it shouldn't be?

						return buffer;
					};
				}

				if (key === 'text') {
					return text;
				}

				if (key === 'json') {
					return async () => {
						return JSON.parse(await text());
					};
				}

				return Reflect.get(response, key, response);
			}
		});

		if (csr) {
			// ensure that excluded headers can't be read
			const get = response.headers.get;
			response.headers.get = (key) => {
				const lower = key.toLowerCase();
				const value = get.call(response.headers, lower);
				if (value && !lower.startsWith('x-sveltekit-')) {
					const included = resolve_opts.filterSerializedResponseHeaders(lower, value);
					if (!included) {
						throw new Error(
							`Failed to get response header "${lower}" — it must be included by the \`filterSerializedResponseHeaders\` option: https://kit.svelte.dev/docs/hooks#server-hooks-handle (at ${event.route.id})`
						);
					}
				}

				return value;
			};
		}

		return proxy;
	};
}

/**
 * @param {ReadableStream<Uint8Array>} stream
 */
async function stream_to_string(stream) {
	let result = '';
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		result += decoder.decode(value);
	}
	return result;
}

/**
 * Hash using djb2
 * @param {import('types').StrictBody[]} values
 */
function hash(...values) {
	let hash = 5381;

	for (const value of values) {
		if (typeof value === 'string') {
			let i = value.length;
			while (i) hash = (hash * 33) ^ value.charCodeAt(--i);
		} else if (ArrayBuffer.isView(value)) {
			const buffer = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
			let i = buffer.length;
			while (i) hash = (hash * 33) ^ buffer[--i];
		} else {
			throw new TypeError('value must be a string or TypedArray');
		}
	}

	return (hash >>> 0).toString(36);
}

/**
 * When inside a double-quoted attribute value, only `&` and `"` hold special meaning.
 * @see https://html.spec.whatwg.org/multipage/parsing.html#attribute-value-(double-quoted)-state
 * @type {Record<string, string>}
 */
const escape_html_attr_dict = {
	'&': '&amp;',
	'"': '&quot;'
};

const escape_html_attr_regex = new RegExp(
	// special characters
	`[${Object.keys(escape_html_attr_dict).join('')}]|` +
		// high surrogate without paired low surrogate
		'[\\ud800-\\udbff](?![\\udc00-\\udfff])|' +
		// a valid surrogate pair, the only match with 2 code units
		// we match it so that we can match unpaired low surrogates in the same pass
		// TODO: use lookbehind assertions once they are widely supported: (?<![\ud800-udbff])[\udc00-\udfff]
		'[\\ud800-\\udbff][\\udc00-\\udfff]|' +
		// unpaired low surrogate (see previous match)
		'[\\udc00-\\udfff]',
	'g'
);

/**
 * Formats a string to be used as an attribute's value in raw HTML.
 *
 * It escapes unpaired surrogates (which are allowed in js strings but invalid in HTML), escapes
 * characters that are special in attributes, and surrounds the whole string in double-quotes.
 *
 * @param {string} str
 * @returns {string} Escaped string surrounded by double-quotes.
 * @example const html = `<tag data-value=${escape_html_attr('value')}>...</tag>`;
 */
function escape_html_attr(str) {
	const escaped_str = str.replace(escape_html_attr_regex, (match) => {
		if (match.length === 2) {
			// valid surrogate pair
			return match;
		}

		return escape_html_attr_dict[match] ?? `&#${match.charCodeAt(0)};`;
	});

	return `"${escaped_str}"`;
}

/**
 * Inside a script element, only `</script` and `<!--` hold special meaning to the HTML parser.
 *
 * The first closes the script element, so everything after is treated as raw HTML.
 * The second disables further parsing until `-->`, so the script element might be unexpectedly
 * kept open until until an unrelated HTML comment in the page.
 *
 * U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are escaped for the sake of pre-2018
 * browsers.
 *
 * @see tests for unsafe parsing examples.
 * @see https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
 * @see https://html.spec.whatwg.org/multipage/syntax.html#cdata-rcdata-restrictions
 * @see https://html.spec.whatwg.org/multipage/parsing.html#script-data-state
 * @see https://html.spec.whatwg.org/multipage/parsing.html#script-data-double-escaped-state
 * @see https://github.com/tc39/proposal-json-superset
 * @type {Record<string, string>}
 */
const replacements = {
	'<': '\\u003C',
	'\u2028': '\\u2028',
	'\u2029': '\\u2029'
};

const pattern = new RegExp(`[${Object.keys(replacements).join('')}]`, 'g');

/**
 * Generates a raw HTML string containing a safe script element carrying data and associated attributes.
 *
 * It escapes all the special characters needed to guarantee the element is unbroken, but care must
 * be taken to ensure it is inserted in the document at an acceptable position for a script element,
 * and that the resulting string isn't further modified.
 *
 * @param {import('./types.js').Fetched} fetched
 * @param {(name: string, value: string) => boolean} filter
 * @param {boolean} [prerendering]
 * @returns {string} The raw HTML of a script element carrying the JSON payload.
 * @example const html = serialize_data('/data.json', null, { foo: 'bar' });
 */
function serialize_data(fetched, filter, prerendering = false) {
	/** @type {Record<string, string>} */
	const headers = {};

	let cache_control = null;
	let age = null;
	let vary = false;

	for (const [key, value] of fetched.response.headers) {
		if (filter(key, value)) {
			headers[key] = value;
		}

		if (key === 'cache-control') cache_control = value;
		if (key === 'age') age = value;
		if (key === 'vary') vary = true;
	}

	const payload = {
		status: fetched.response.status,
		statusText: fetched.response.statusText,
		headers,
		body: fetched.response_body
	};

	const safe_payload = JSON.stringify(payload).replace(pattern, (match) => replacements[match]);

	const attrs = [
		'type="application/json"',
		'data-sveltekit-fetched',
		`data-url=${escape_html_attr(fetched.url)}`
	];

	if (fetched.request_headers || fetched.request_body) {
		/** @type {import('types').StrictBody[]} */
		const values = [];

		if (fetched.request_headers) {
			values.push([...new Headers(fetched.request_headers)].join(','));
		}

		if (fetched.request_body) {
			values.push(fetched.request_body);
		}

		attrs.push(`data-hash="${hash(...values)}"`);
	}

	// Compute the time the response should be cached, taking into account max-age and age.
	// Do not cache at all if a vary header is present, as this indicates that the cache is
	// likely to get busted. It would also mean we'd have to add more logic to computing the
	// selector on the client which results in more code for 99% of people for the 1% who use vary.
	if (!prerendering && fetched.method === 'GET' && cache_control && !vary) {
		const match = /s-maxage=(\d+)/g.exec(cache_control) ?? /max-age=(\d+)/g.exec(cache_control);
		if (match) {
			const ttl = +match[1] - +(age ?? '0');
			attrs.push(`data-ttl="${ttl}"`);
		}
	}

	return `<script ${attrs.join(' ')}>${safe_payload}</script>`;
}

const s = JSON.stringify;

const encoder$2 = new TextEncoder();

/**
 * SHA-256 hashing function adapted from https://bitwiseshiftleft.github.io/sjcl
 * modified and redistributed under BSD license
 * @param {string} data
 */
function sha256(data) {
	if (!key[0]) precompute();

	const out = init.slice(0);
	const array = encode(data);

	for (let i = 0; i < array.length; i += 16) {
		const w = array.subarray(i, i + 16);

		let tmp;
		let a;
		let b;

		let out0 = out[0];
		let out1 = out[1];
		let out2 = out[2];
		let out3 = out[3];
		let out4 = out[4];
		let out5 = out[5];
		let out6 = out[6];
		let out7 = out[7];

		/* Rationale for placement of |0 :
		 * If a value can overflow is original 32 bits by a factor of more than a few
		 * million (2^23 ish), there is a possibility that it might overflow the
		 * 53-bit mantissa and lose precision.
		 *
		 * To avoid this, we clamp back to 32 bits by |'ing with 0 on any value that
		 * propagates around the loop, and on the hash state out[]. I don't believe
		 * that the clamps on out4 and on out0 are strictly necessary, but it's close
		 * (for out4 anyway), and better safe than sorry.
		 *
		 * The clamps on out[] are necessary for the output to be correct even in the
		 * common case and for short inputs.
		 */

		for (let i = 0; i < 64; i++) {
			// load up the input word for this round

			if (i < 16) {
				tmp = w[i];
			} else {
				a = w[(i + 1) & 15];

				b = w[(i + 14) & 15];

				tmp = w[i & 15] =
					(((a >>> 7) ^ (a >>> 18) ^ (a >>> 3) ^ (a << 25) ^ (a << 14)) +
						((b >>> 17) ^ (b >>> 19) ^ (b >>> 10) ^ (b << 15) ^ (b << 13)) +
						w[i & 15] +
						w[(i + 9) & 15]) |
					0;
			}

			tmp =
				tmp +
				out7 +
				((out4 >>> 6) ^ (out4 >>> 11) ^ (out4 >>> 25) ^ (out4 << 26) ^ (out4 << 21) ^ (out4 << 7)) +
				(out6 ^ (out4 & (out5 ^ out6))) +
				key[i]; // | 0;

			// shift register
			out7 = out6;
			out6 = out5;
			out5 = out4;

			out4 = (out3 + tmp) | 0;

			out3 = out2;
			out2 = out1;
			out1 = out0;

			out0 =
				(tmp +
					((out1 & out2) ^ (out3 & (out1 ^ out2))) +
					((out1 >>> 2) ^
						(out1 >>> 13) ^
						(out1 >>> 22) ^
						(out1 << 30) ^
						(out1 << 19) ^
						(out1 << 10))) |
				0;
		}

		out[0] = (out[0] + out0) | 0;
		out[1] = (out[1] + out1) | 0;
		out[2] = (out[2] + out2) | 0;
		out[3] = (out[3] + out3) | 0;
		out[4] = (out[4] + out4) | 0;
		out[5] = (out[5] + out5) | 0;
		out[6] = (out[6] + out6) | 0;
		out[7] = (out[7] + out7) | 0;
	}

	const bytes = new Uint8Array(out.buffer);
	reverse_endianness(bytes);

	return base64(bytes);
}

/** The SHA-256 initialization vector */
const init = new Uint32Array(8);

/** The SHA-256 hash key */
const key = new Uint32Array(64);

/** Function to precompute init and key. */
function precompute() {
	/** @param {number} x */
	function frac(x) {
		return (x - Math.floor(x)) * 0x100000000;
	}

	let prime = 2;

	for (let i = 0; i < 64; prime++) {
		let is_prime = true;

		for (let factor = 2; factor * factor <= prime; factor++) {
			if (prime % factor === 0) {
				is_prime = false;

				break;
			}
		}

		if (is_prime) {
			if (i < 8) {
				init[i] = frac(prime ** (1 / 2));
			}

			key[i] = frac(prime ** (1 / 3));

			i++;
		}
	}
}

/** @param {Uint8Array} bytes */
function reverse_endianness(bytes) {
	for (let i = 0; i < bytes.length; i += 4) {
		const a = bytes[i + 0];
		const b = bytes[i + 1];
		const c = bytes[i + 2];
		const d = bytes[i + 3];

		bytes[i + 0] = d;
		bytes[i + 1] = c;
		bytes[i + 2] = b;
		bytes[i + 3] = a;
	}
}

/** @param {string} str */
function encode(str) {
	const encoded = encoder$2.encode(str);
	const length = encoded.length * 8;

	// result should be a multiple of 512 bits in length,
	// with room for a 1 (after the data) and two 32-bit
	// words containing the original input bit length
	const size = 512 * Math.ceil((length + 65) / 512);
	const bytes = new Uint8Array(size / 8);
	bytes.set(encoded);

	// append a 1
	bytes[encoded.length] = 0b10000000;

	reverse_endianness(bytes);

	// add the input bit length
	const words = new Uint32Array(bytes.buffer);
	words[words.length - 2] = Math.floor(length / 0x100000000); // this will always be zero for us
	words[words.length - 1] = length;

	return words;
}

/*
	Based on https://gist.github.com/enepomnyaschih/72c423f727d395eeaa09697058238727

	MIT License
	Copyright (c) 2020 Egor Nepomnyaschih
	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files (the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions:
	The above copyright notice and this permission notice shall be included in all
	copies or substantial portions of the Software.
	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
	SOFTWARE.
*/
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('');

/** @param {Uint8Array} bytes */
function base64(bytes) {
	const l = bytes.length;

	let result = '';
	let i;

	for (i = 2; i < l; i += 3) {
		result += chars[bytes[i - 2] >> 2];
		result += chars[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)];
		result += chars[((bytes[i - 1] & 0x0f) << 2) | (bytes[i] >> 6)];
		result += chars[bytes[i] & 0x3f];
	}

	if (i === l + 1) {
		// 1 octet yet to write
		result += chars[bytes[i - 2] >> 2];
		result += chars[(bytes[i - 2] & 0x03) << 4];
		result += '==';
	}

	if (i === l) {
		// 2 octets yet to write
		result += chars[bytes[i - 2] >> 2];
		result += chars[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)];
		result += chars[(bytes[i - 1] & 0x0f) << 2];
		result += '=';
	}

	return result;
}

const array = new Uint8Array(16);

function generate_nonce() {
	crypto.getRandomValues(array);
	return base64(array);
}

const quoted = new Set([
	'self',
	'unsafe-eval',
	'unsafe-hashes',
	'unsafe-inline',
	'none',
	'strict-dynamic',
	'report-sample',
	'wasm-unsafe-eval',
	'script'
]);

const crypto_pattern = /^(nonce|sha\d\d\d)-/;

// CSP and CSP Report Only are extremely similar with a few caveats
// the easiest/DRYest way to express this is with some private encapsulation
class BaseProvider {
	/** @type {boolean} */
	#use_hashes;

	/** @type {boolean} */
	#script_needs_csp;

	/** @type {boolean} */
	#style_needs_csp;

	/** @type {import('types').CspDirectives} */
	#directives;

	/** @type {import('types').Csp.Source[]} */
	#script_src;

	/** @type {import('types').Csp.Source[]} */
	#style_src;

	/** @type {string} */
	#nonce;

	/**
	 * @param {boolean} use_hashes
	 * @param {import('types').CspDirectives} directives
	 * @param {string} nonce
	 */
	constructor(use_hashes, directives, nonce) {
		this.#use_hashes = use_hashes;
		this.#directives = directives; // clone in dev so we can safely mutate

		const d = this.#directives;

		this.#script_src = [];
		this.#style_src = [];

		const effective_script_src = d['script-src'] || d['default-src'];
		const effective_style_src = d['style-src'] || d['default-src'];

		this.#script_needs_csp =
			!!effective_script_src &&
			effective_script_src.filter((value) => value !== 'unsafe-inline').length > 0;

		this.#style_needs_csp =
			!!effective_style_src &&
			effective_style_src.filter((value) => value !== 'unsafe-inline').length > 0;

		this.script_needs_nonce = this.#script_needs_csp && !this.#use_hashes;
		this.style_needs_nonce = this.#style_needs_csp && !this.#use_hashes;
		this.#nonce = nonce;
	}

	/** @param {string} content */
	add_script(content) {
		if (this.#script_needs_csp) {
			if (this.#use_hashes) {
				this.#script_src.push(`sha256-${sha256(content)}`);
			} else if (this.#script_src.length === 0) {
				this.#script_src.push(`nonce-${this.#nonce}`);
			}
		}
	}

	/** @param {string} content */
	add_style(content) {
		if (this.#style_needs_csp) {
			if (this.#use_hashes) {
				this.#style_src.push(`sha256-${sha256(content)}`);
			} else if (this.#style_src.length === 0) {
				this.#style_src.push(`nonce-${this.#nonce}`);
			}
		}
	}

	/**
	 * @param {boolean} [is_meta]
	 */
	get_header(is_meta = false) {
		const header = [];

		// due to browser inconsistencies, we can't append sources to default-src
		// (specifically, Firefox appears to not ignore nonce-{nonce} directives
		// on default-src), so we ensure that script-src and style-src exist

		const directives = { ...this.#directives };

		if (this.#style_src.length > 0) {
			directives['style-src'] = [
				...(directives['style-src'] || directives['default-src'] || []),
				...this.#style_src
			];
		}

		if (this.#script_src.length > 0) {
			directives['script-src'] = [
				...(directives['script-src'] || directives['default-src'] || []),
				...this.#script_src
			];
		}

		for (const key in directives) {
			if (is_meta && (key === 'frame-ancestors' || key === 'report-uri' || key === 'sandbox')) {
				// these values cannot be used with a <meta> tag
				// TODO warn?
				continue;
			}

			// @ts-expect-error gimme a break typescript, `key` is obviously a member of internal_directives
			const value = /** @type {string[] | true} */ (directives[key]);

			if (!value) continue;

			const directive = [key];
			if (Array.isArray(value)) {
				value.forEach((value) => {
					if (quoted.has(value) || crypto_pattern.test(value)) {
						directive.push(`'${value}'`);
					} else {
						directive.push(value);
					}
				});
			}

			header.push(directive.join(' '));
		}

		return header.join('; ');
	}
}

class CspProvider extends BaseProvider {
	get_meta() {
		const content = escape_html_attr(this.get_header(true));
		return `<meta http-equiv="content-security-policy" content=${content}>`;
	}
}

class CspReportOnlyProvider extends BaseProvider {
	/**
	 * @param {boolean} use_hashes
	 * @param {import('types').CspDirectives} directives
	 * @param {string} nonce
	 */
	constructor(use_hashes, directives, nonce) {
		super(use_hashes, directives, nonce);

		if (Object.values(directives).filter((v) => !!v).length > 0) {
			// If we're generating content-security-policy-report-only,
			// if there are any directives, we need a report-uri or report-to (or both)
			// else it's just an expensive noop.
			const has_report_to = directives['report-to']?.length ?? 0 > 0;
			const has_report_uri = directives['report-uri']?.length ?? 0 > 0;
			if (!has_report_to && !has_report_uri) {
				throw Error(
					'`content-security-policy-report-only` must be specified with either the `report-to` or `report-uri` directives, or both'
				);
			}
		}
	}
}

class Csp {
	/** @readonly */
	nonce = generate_nonce();

	/** @type {CspProvider} */
	csp_provider;

	/** @type {CspReportOnlyProvider} */
	report_only_provider;

	/**
	 * @param {import('./types').CspConfig} config
	 * @param {import('./types').CspOpts} opts
	 */
	constructor({ mode, directives, reportOnly }, { prerender }) {
		const use_hashes = mode === 'hash' || (mode === 'auto' && prerender);
		this.csp_provider = new CspProvider(use_hashes, directives, this.nonce);
		this.report_only_provider = new CspReportOnlyProvider(use_hashes, reportOnly, this.nonce);
	}

	get script_needs_nonce() {
		return this.csp_provider.script_needs_nonce || this.report_only_provider.script_needs_nonce;
	}

	get style_needs_nonce() {
		return this.csp_provider.style_needs_nonce || this.report_only_provider.style_needs_nonce;
	}

	/** @param {string} content */
	add_script(content) {
		this.csp_provider.add_script(content);
		this.report_only_provider.add_script(content);
	}

	/** @param {string} content */
	add_style(content) {
		this.csp_provider.add_style(content);
		this.report_only_provider.add_style(content);
	}
}

/**
 * @returns {import("types").Deferred & { promise: Promise<any> }}}
 */
function defer() {
	let fulfil;
	let reject;

	const promise = new Promise((f, r) => {
		fulfil = f;
		reject = r;
	});

	// @ts-expect-error
	return { promise, fulfil, reject };
}

/**
 * Create an async iterator and a function to push values into it
 * @returns {{
 *   iterator: AsyncIterable<any>;
 *   push: (value: any) => void;
 *   done: () => void;
 * }}
 */
function create_async_iterator() {
	let deferred = [defer()];

	return {
		iterator: {
			[Symbol.asyncIterator]() {
				return {
					next: async () => {
						const next = await deferred[0].promise;
						if (!next.done) deferred.shift();
						return next;
					}
				};
			}
		},
		push: (value) => {
			deferred[deferred.length - 1].fulfil({
				value,
				done: false
			});
			deferred.push(defer());
		},
		done: () => {
			deferred[deferred.length - 1].fulfil({ done: true });
		}
	};
}

/**
 * A fake asset path used in `vite dev` and `vite preview`, so that we can
 * serve local assets while verifying that requests are correctly prefixed
 */
const SVELTE_KIT_ASSETS = '/_svelte_kit_assets';

// TODO rename this function/module

const updated = {
	...readable(false),
	check: () => false
};

const encoder$1 = new TextEncoder();

/**
 * Creates the HTML response.
 * @param {{
 *   branch: Array<import('./types').Loaded>;
 *   fetched: Array<import('./types').Fetched>;
 *   options: import('types').SSROptions;
 *   manifest: import('types').SSRManifest;
 *   state: import('types').SSRState;
 *   page_config: { ssr: boolean; csr: boolean };
 *   status: number;
 *   error: App.Error | null;
 *   event: import('types').RequestEvent;
 *   resolve_opts: import('types').RequiredResolveOptions;
 *   action_result?: import('types').ActionResult;
 * }} opts
 */
async function render_response({
	branch,
	fetched,
	options,
	manifest,
	state,
	page_config,
	status,
	error = null,
	event,
	resolve_opts,
	action_result
}) {
	if (state.prerendering) {
		if (options.csp.mode === 'nonce') {
			throw new Error('Cannot use prerendering if config.kit.csp.mode === "nonce"');
		}

		if (options.app_template_contains_nonce) {
			throw new Error('Cannot use prerendering if page template contains %sveltekit.nonce%');
		}
	}

	const { client } = manifest._;

	const modulepreloads = new Set(client.imports);
	const stylesheets = new Set(client.stylesheets);
	const fonts = new Set(client.fonts);

	/** @type {Set<string>} */
	const link_header_preloads = new Set();

	/** @type {Map<string, string>} */
	// TODO if we add a client entry point one day, we will need to include inline_styles with the entry, otherwise stylesheets will be linked even if they are below inlineStyleThreshold
	const inline_styles = new Map();

	let rendered;

	const form_value =
		action_result?.type === 'success' || action_result?.type === 'failure'
			? action_result.data ?? null
			: null;

	/** @type {string} */
	let base$1 = base;

	/** @type {string} */
	let assets$1 = assets;

	/**
	 * An expression that will evaluate in the client to determine the resolved base path.
	 * We use a relative path when possible to support IPFS, the internet archive, etc.
	 */
	let base_expression = s(base);

	// if appropriate, use relative paths for greater portability
	if (!state.prerendering?.fallback) {
		const segments = event.url.pathname.slice(base.length).split('/').slice(2);

		base$1 = segments.map(() => '..').join('/') || '.';

		// resolve e.g. '../..' against current location, then remove trailing slash
		base_expression = `new URL(${s(base$1)}, location).pathname.slice(0, -1)`;

		if (!assets || (assets[0] === '/' && assets !== SVELTE_KIT_ASSETS)) {
			assets$1 = base$1;
		}
	}

	if (page_config.ssr) {

		/** @type {Record<string, any>} */
		const props = {
			stores: {
				page: writable(null),
				navigating: writable(null),
				updated
			},
			constructors: await Promise.all(branch.map(({ node }) => node.component())),
			form: form_value
		};

		let data = {};

		// props_n (instead of props[n]) makes it easy to avoid
		// unnecessary updates for layout components
		for (let i = 0; i < branch.length; i += 1) {
			data = { ...data, ...branch[i].data };
			props[`data_${i}`] = data;
		}

		props.page = {
			error,
			params: /** @type {Record<string, any>} */ (event.params),
			route: event.route,
			status,
			url: event.url,
			data,
			form: form_value
		};

		{
			try {
				rendered = options.root.render(props);
			} finally {
				reset();
			}
		}

		for (const { node } of branch) {
			for (const url of node.imports) modulepreloads.add(url);
			for (const url of node.stylesheets) stylesheets.add(url);
			for (const url of node.fonts) fonts.add(url);

			if (node.inline_styles) {
				Object.entries(await node.inline_styles()).forEach(([k, v]) => inline_styles.set(k, v));
			}
		}
	} else {
		rendered = { head: '', html: '', css: { code: '', map: null } };
	}

	let head = '';
	let body = rendered.html;

	const csp = new Csp(options.csp, {
		prerender: !!state.prerendering
	});

	/** @param {string} path */
	const prefixed = (path) => {
		if (path.startsWith('/')) {
			// Vite makes the start script available through the base path and without it.
			// We load it via the base path in order to support remote IDE environments which proxy
			// all URLs under the base path during development.
			return base + path;
		}
		return `${assets$1}/${path}`;
	};

	if (inline_styles.size > 0) {
		const content = Array.from(inline_styles.values()).join('\n');

		const attributes = [];
		if (csp.style_needs_nonce) attributes.push(` nonce="${csp.nonce}"`);

		csp.add_style(content);

		head += `\n\t<style${attributes.join('')}>${content}</style>`;
	}

	for (const dep of stylesheets) {
		const path = prefixed(dep);

		const attributes = ['rel="stylesheet"'];

		if (inline_styles.has(dep)) {
			// don't load stylesheets that are already inlined
			// include them in disabled state so that Vite can detect them and doesn't try to add them
			attributes.push('disabled', 'media="(max-width: 0)"');
		} else {
			if (resolve_opts.preload({ type: 'css', path })) {
				const preload_atts = ['rel="preload"', 'as="style"'];
				link_header_preloads.add(`<${encodeURI(path)}>; ${preload_atts.join(';')}; nopush`);
			}
		}

		head += `\n\t\t<link href="${path}" ${attributes.join(' ')}>`;
	}

	for (const dep of fonts) {
		const path = prefixed(dep);

		if (resolve_opts.preload({ type: 'font', path })) {
			const ext = dep.slice(dep.lastIndexOf('.') + 1);
			const attributes = [
				'rel="preload"',
				'as="font"',
				`type="font/${ext}"`,
				`href="${path}"`,
				'crossorigin'
			];

			head += `\n\t\t<link ${attributes.join(' ')}>`;
		}
	}

	const global = `__sveltekit_${options.version_hash}`;

	const { data, chunks } = get_data(
		event,
		options,
		branch.map((b) => b.server_data),
		global
	);

	if (page_config.ssr && page_config.csr) {
		body += `\n\t\t\t${fetched
			.map((item) =>
				serialize_data(item, resolve_opts.filterSerializedResponseHeaders, !!state.prerendering)
			)
			.join('\n\t\t\t')}`;
	}

	if (page_config.csr) {
		const included_modulepreloads = Array.from(modulepreloads, (dep) => prefixed(dep)).filter(
			(path) => resolve_opts.preload({ type: 'js', path })
		);

		for (const path of included_modulepreloads) {
			// see the kit.output.preloadStrategy option for details on why we have multiple options here
			link_header_preloads.add(`<${encodeURI(path)}>; rel="modulepreload"; nopush`);
			if (options.preload_strategy !== 'modulepreload') {
				head += `\n\t\t<link rel="preload" as="script" crossorigin="anonymous" href="${path}">`;
			} else if (state.prerendering) {
				head += `\n\t\t<link rel="modulepreload" href="${path}">`;
			}
		}

		const blocks = [];

		const properties = [
			assets && `assets: ${s(assets)}`,
			`base: ${base_expression}`,
			`env: ${s(public_env)}`
		].filter(Boolean);

		if (chunks) {
			blocks.push(`const deferred = new Map();`);

			properties.push(`defer: (id) => new Promise((fulfil, reject) => {
							deferred.set(id, { fulfil, reject });
						})`);

			properties.push(`resolve: ({ id, data, error }) => {
							const { fulfil, reject } = deferred.get(id);
							deferred.delete(id);

							if (error) reject(error);
							else fulfil(data);
						}`);
		}

		blocks.push(`${global} = {
						${properties.join(',\n\t\t\t\t\t\t')}
					};`);

		const args = [`app`, `element`];

		blocks.push(`const element = document.currentScript.parentElement;`);

		if (page_config.ssr) {
			const serialized = { form: 'null', error: 'null' };

			blocks.push(`const data = ${data};`);

			if (form_value) {
				serialized.form = uneval_action_response(
					form_value,
					/** @type {string} */ (event.route.id)
				);
			}

			if (error) {
				serialized.error = uneval(error);
			}

			const hydrate = [
				`node_ids: [${branch.map(({ node }) => node.index).join(', ')}]`,
				`data`,
				`form: ${serialized.form}`,
				`error: ${serialized.error}`
			];

			if (status !== 200) {
				hydrate.push(`status: ${status}`);
			}

			if (options.embedded) {
				hydrate.push(`params: ${uneval(event.params)}`, `route: ${s(event.route)}`);
			}

			args.push(`{\n\t\t\t\t\t\t\t${hydrate.join(',\n\t\t\t\t\t\t\t')}\n\t\t\t\t\t\t}`);
		}

		blocks.push(`Promise.all([
						import(${s(prefixed(client.start))}),
						import(${s(prefixed(client.app))})
					]).then(([kit, app]) => {
						kit.start(${args.join(', ')});
					});`);

		if (options.service_worker) {
			const opts = '';

			// we use an anonymous function instead of an arrow function to support
			// older browsers (https://github.com/sveltejs/kit/pull/5417)
			blocks.push(`if ('serviceWorker' in navigator) {
						addEventListener('load', function () {
							navigator.serviceWorker.register('${prefixed('service-worker.js')}'${opts});
						});
					}`);
		}

		const init_app = `
				{
					${blocks.join('\n\n\t\t\t\t\t')}
				}
			`;
		csp.add_script(init_app);

		body += `\n\t\t\t<script${
			csp.script_needs_nonce ? ` nonce="${csp.nonce}"` : ''
		}>${init_app}</script>\n\t\t`;
	}

	const headers = new Headers({
		'x-sveltekit-page': 'true',
		'content-type': 'text/html'
	});

	if (state.prerendering) {
		// TODO read headers set with setHeaders and convert into http-equiv where possible
		const http_equiv = [];

		const csp_headers = csp.csp_provider.get_meta();
		if (csp_headers) {
			http_equiv.push(csp_headers);
		}

		if (state.prerendering.cache) {
			http_equiv.push(`<meta http-equiv="cache-control" content="${state.prerendering.cache}">`);
		}

		if (http_equiv.length > 0) {
			head = http_equiv.join('\n') + head;
		}
	} else {
		const csp_header = csp.csp_provider.get_header();
		if (csp_header) {
			headers.set('content-security-policy', csp_header);
		}
		const report_only_header = csp.report_only_provider.get_header();
		if (report_only_header) {
			headers.set('content-security-policy-report-only', report_only_header);
		}

		if (link_header_preloads.size) {
			headers.set('link', Array.from(link_header_preloads).join(', '));
		}
	}

	// add the content after the script/css links so the link elements are parsed first
	head += rendered.head;

	const html = options.templates.app({
		head,
		body,
		assets: assets$1,
		nonce: /** @type {string} */ (csp.nonce),
		env: public_env
	});

	// TODO flush chunks as early as we can
	const transformed =
		(await resolve_opts.transformPageChunk({
			html,
			done: true
		})) || '';

	if (!chunks) {
		headers.set('etag', `"${hash(transformed)}"`);
	}

	return !chunks
		? text(transformed, {
				status,
				headers
		  })
		: new Response(
				new ReadableStream({
					async start(controller) {
						controller.enqueue(encoder$1.encode(transformed + '\n'));
						for await (const chunk of chunks) {
							controller.enqueue(encoder$1.encode(chunk));
						}
						controller.close();
					},

					type: 'bytes'
				}),
				{
					headers: {
						'content-type': 'text/html'
					}
				}
		  );
}

/**
 * If the serialized data contains promises, `chunks` will be an
 * async iterable containing their resolutions
 * @param {import('types').RequestEvent} event
 * @param {import('types').SSROptions} options
 * @param {Array<import('types').ServerDataNode | null>} nodes
 * @param {string} global
 * @returns {{ data: string, chunks: AsyncIterable<string> | null }}
 */
function get_data(event, options, nodes, global) {
	let promise_id = 1;
	let count = 0;

	const { iterator, push, done } = create_async_iterator();

	/** @param {any} thing */
	function replacer(thing) {
		if (typeof thing?.then === 'function') {
			const id = promise_id++;
			count += 1;

			thing
				.then(/** @param {any} data */ (data) => ({ data }))
				.catch(
					/** @param {any} error */ async (error) => ({
						error: await handle_error_and_jsonify(event, options, error)
					})
				)
				.then(
					/**
					 * @param {{data: any; error: any}} result
					 */
					async ({ data, error }) => {
						count -= 1;

						let str;
						try {
							str = uneval({ id, data, error }, replacer);
						} catch (e) {
							error = await handle_error_and_jsonify(
								event,
								options,
								new Error(`Failed to serialize promise while rendering ${event.route.id}`)
							);
							data = undefined;
							str = uneval({ id, data, error }, replacer);
						}

						push(`<script>${global}.resolve(${str})</script>\n`);
						if (count === 0) done();
					}
				);

			return `${global}.defer(${id})`;
		}
	}

	try {
		const strings = nodes.map((node) => {
			if (!node) return 'null';

			return `{"type":"data","data":${uneval(node.data, replacer)},${stringify_uses(node)}${
				node.slash ? `,"slash":${JSON.stringify(node.slash)}` : ''
			}}`;
		});

		return {
			data: `[${strings.join(',')}]`,
			chunks: count > 0 ? iterator : null
		};
	} catch (e) {
		throw new Error(clarify_devalue_error(event, /** @type {any} */ (e)));
	}
}

/**
 * @template {'prerender' | 'ssr' | 'csr' | 'trailingSlash' | 'entries'} Option
 * @template {(import('types').SSRNode['universal'] | import('types').SSRNode['server'])[Option]} Value
 *
 * @param {Array<import('types').SSRNode | undefined>} nodes
 * @param {Option} option
 *
 * @returns {Value | undefined}
 */
function get_option(nodes, option) {
	return nodes.reduce((value, node) => {
		return /** @type {Value} TypeScript's too dumb to understand this */ (
			node?.universal?.[option] ?? node?.server?.[option] ?? value
		);
	}, /** @type {Value | undefined} */ (undefined));
}

/**
 * @typedef {import('./types.js').Loaded} Loaded
 */

/**
 * @param {{
 *   event: import('types').RequestEvent;
 *   options: import('types').SSROptions;
 *   manifest: import('types').SSRManifest;
 *   state: import('types').SSRState;
 *   status: number;
 *   error: unknown;
 *   resolve_opts: import('types').RequiredResolveOptions;
 * }} opts
 */
async function respond_with_error({
	event,
	options,
	manifest,
	state,
	status,
	error,
	resolve_opts
}) {
	/** @type {import('./types').Fetched[]} */
	const fetched = [];

	try {
		const branch = [];
		const default_layout = await manifest._.nodes[0](); // 0 is always the root layout
		const ssr = get_option([default_layout], 'ssr') ?? true;
		const csr = get_option([default_layout], 'csr') ?? true;

		if (ssr) {
			state.error = true;

			const server_data_promise = load_server_data({
				event,
				state,
				node: default_layout,
				parent: async () => ({})
			});

			const server_data = await server_data_promise;

			const data = await load_data({
				event,
				fetched,
				node: default_layout,
				parent: async () => ({}),
				resolve_opts,
				server_data_promise,
				state,
				csr
			});

			branch.push(
				{
					node: default_layout,
					server_data,
					data
				},
				{
					node: await manifest._.nodes[1](), // 1 is always the root error
					data: null,
					server_data: null
				}
			);
		}

		return await render_response({
			options,
			manifest,
			state,
			page_config: {
				ssr,
				csr: get_option([default_layout], 'csr') ?? true
			},
			status,
			error: await handle_error_and_jsonify(event, options, error),
			branch,
			fetched,
			event,
			resolve_opts
		});
	} catch (e) {
		// Edge case: If route is a 404 and the user redirects to somewhere from the root layout,
		// we end up here.
		if (e instanceof Redirect) {
			return redirect_response(e.status, e.location);
		}

		return static_error_page(
			options,
			e instanceof HttpError ? e.status : 500,
			(await handle_error_and_jsonify(event, options, e)).message
		);
	}
}

/**
 * @template T
 * @param {() => T} fn
 */
function once(fn) {
	let done = false;

	/** @type T */
	let result;

	return () => {
		if (done) return result;
		done = true;
		return (result = fn());
	};
}

const encoder = new TextEncoder();

/**
 * @param {import('types').RequestEvent} event
 * @param {import('types').SSRRoute} route
 * @param {import('types').SSROptions} options
 * @param {import('types').SSRManifest} manifest
 * @param {import('types').SSRState} state
 * @param {boolean[] | undefined} invalidated_data_nodes
 * @param {import('types').TrailingSlash} trailing_slash
 * @returns {Promise<Response>}
 */
async function render_data(
	event,
	route,
	options,
	manifest,
	state,
	invalidated_data_nodes,
	trailing_slash
) {
	if (!route.page) {
		// requesting /__data.json should fail for a +server.js
		return new Response(undefined, {
			status: 404
		});
	}

	try {
		const node_ids = [...route.page.layouts, route.page.leaf];
		const invalidated = invalidated_data_nodes ?? node_ids.map(() => true);

		let aborted = false;

		const url = new URL(event.url);
		url.pathname = normalize_path(url.pathname, trailing_slash);

		const new_event = { ...event, url };

		const functions = node_ids.map((n, i) => {
			return once(async () => {
				try {
					if (aborted) {
						return /** @type {import('types').ServerDataSkippedNode} */ ({
							type: 'skip'
						});
					}

					// == because it could be undefined (in dev) or null (in build, because of JSON.stringify)
					const node = n == undefined ? n : await manifest._.nodes[n]();
					// load this. for the child, return as is. for the final result, stream things
					return load_server_data({
						event: new_event,
						state,
						node,
						parent: async () => {
							/** @type {Record<string, any>} */
							const data = {};
							for (let j = 0; j < i; j += 1) {
								const parent = /** @type {import('types').ServerDataNode | null} */ (
									await functions[j]()
								);

								if (parent) {
									Object.assign(data, parent.data);
								}
							}
							return data;
						}
					});
				} catch (e) {
					aborted = true;
					throw e;
				}
			});
		});

		const promises = functions.map(async (fn, i) => {
			if (!invalidated[i]) {
				return /** @type {import('types').ServerDataSkippedNode} */ ({
					type: 'skip'
				});
			}

			return fn();
		});

		let length = promises.length;
		const nodes = await Promise.all(
			promises.map((p, i) =>
				p.catch(async (error) => {
					if (error instanceof Redirect) {
						throw error;
					}

					// Math.min because array isn't guaranteed to resolve in order
					length = Math.min(length, i + 1);

					return /** @type {import('types').ServerErrorNode} */ ({
						type: 'error',
						error: await handle_error_and_jsonify(event, options, error),
						status: error instanceof HttpError ? error.status : undefined
					});
				})
			)
		);

		const { data, chunks } = get_data_json(event, options, nodes);

		if (!chunks) {
			// use a normal JSON response where possible, so we get `content-length`
			// and can use browser JSON devtools for easier inspecting
			return json_response(data);
		}

		return new Response(
			new ReadableStream({
				async start(controller) {
					controller.enqueue(encoder.encode(data));
					for await (const chunk of chunks) {
						controller.enqueue(encoder.encode(chunk));
					}
					controller.close();
				},

				type: 'bytes'
			}),
			{
				headers: {
					// we use a proprietary content type to prevent buffering.
					// the `text` prefix makes it inspectable
					'content-type': 'text/sveltekit-data',
					'cache-control': 'private, no-store'
				}
			}
		);
	} catch (e) {
		const error = normalize_error(e);

		if (error instanceof Redirect) {
			return redirect_json_response(error);
		} else {
			return json_response(await handle_error_and_jsonify(event, options, error), 500);
		}
	}
}

/**
 * @param {Record<string, any> | string} json
 * @param {number} [status]
 */
function json_response(json, status = 200) {
	return text(typeof json === 'string' ? json : JSON.stringify(json), {
		status,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'private, no-store'
		}
	});
}

/**
 * @param {Redirect} redirect
 */
function redirect_json_response(redirect) {
	return json_response({
		type: 'redirect',
		location: redirect.location
	});
}

/**
 * If the serialized data contains promises, `chunks` will be an
 * async iterable containing their resolutions
 * @param {import('types').RequestEvent} event
 * @param {import('types').SSROptions} options
 * @param {Array<import('types').ServerDataSkippedNode | import('types').ServerDataNode | import('types').ServerErrorNode | null | undefined>} nodes
 *  @returns {{ data: string, chunks: AsyncIterable<string> | null }}
 */
function get_data_json(event, options, nodes) {
	let promise_id = 1;
	let count = 0;

	const { iterator, push, done } = create_async_iterator();

	const reducers = {
		/** @param {any} thing */
		Promise: (thing) => {
			if (typeof thing?.then === 'function') {
				const id = promise_id++;
				count += 1;

				/** @type {'data' | 'error'} */
				let key = 'data';

				thing
					.catch(
						/** @param {any} e */ async (e) => {
							key = 'error';
							return handle_error_and_jsonify(event, options, /** @type {any} */ (e));
						}
					)
					.then(
						/** @param {any} value */
						async (value) => {
							let str;
							try {
								str = stringify(value, reducers);
							} catch (e) {
								const error = await handle_error_and_jsonify(
									event,
									options,
									new Error(`Failed to serialize promise while rendering ${event.route.id}`)
								);

								key = 'error';
								str = stringify(error, reducers);
							}

							count -= 1;

							push(`{"type":"chunk","id":${id},"${key}":${str}}\n`);
							if (count === 0) done();
						}
					);

				return id;
			}
		}
	};

	try {
		const strings = nodes.map((node) => {
			if (!node) return 'null';

			if (node.type === 'error' || node.type === 'skip') {
				return JSON.stringify(node);
			}

			return `{"type":"data","data":${stringify(node.data, reducers)},${stringify_uses(
				node
			)}${node.slash ? `,"slash":${JSON.stringify(node.slash)}` : ''}}`;
		});

		return {
			data: `{"type":"data","nodes":[${strings.join(',')}]}\n`,
			chunks: count > 0 ? iterator : null
		};
	} catch (e) {
		throw new Error(clarify_devalue_error(event, /** @type {any} */ (e)));
	}
}

/**
 * The maximum request depth permitted before assuming we're stuck in an infinite loop
 */
const MAX_DEPTH = 10;

/**
 * @param {import('types').RequestEvent} event
 * @param {import('types').PageNodeIndexes} page
 * @param {import('types').SSROptions} options
 * @param {import('types').SSRManifest} manifest
 * @param {import('types').SSRState} state
 * @param {import('types').RequiredResolveOptions} resolve_opts
 * @returns {Promise<Response>}
 */
async function render_page(event, page, options, manifest, state, resolve_opts) {
	if (state.depth > MAX_DEPTH) {
		// infinite request cycle detected
		return text(`Not found: ${event.url.pathname}`, {
			status: 404 // TODO in some cases this should be 500. not sure how to differentiate
		});
	}

	if (is_action_json_request(event)) {
		const node = await manifest._.nodes[page.leaf]();
		return handle_action_json_request(event, options, node?.server);
	}

	try {
		const nodes = await Promise.all([
			// we use == here rather than === because [undefined] serializes as "[null]"
			...page.layouts.map((n) => (n == undefined ? n : manifest._.nodes[n]())),
			manifest._.nodes[page.leaf]()
		]);

		const leaf_node = /** @type {import('types').SSRNode} */ (nodes.at(-1));

		let status = 200;

		/** @type {import('types').ActionResult | undefined} */
		let action_result = undefined;

		if (is_action_request(event)) {
			// for action requests, first call handler in +page.server.js
			// (this also determines status code)
			action_result = await handle_action_request(event, leaf_node.server);
			if (action_result?.type === 'redirect') {
				return redirect_response(action_result.status, action_result.location);
			}
			if (action_result?.type === 'error') {
				const error = action_result.error;
				status = error instanceof HttpError ? error.status : 500;
			}
			if (action_result?.type === 'failure') {
				status = action_result.status;
			}
		}

		const should_prerender_data = nodes.some((node) => node?.server);
		const data_pathname = add_data_suffix(event.url.pathname);

		// it's crucial that we do this before returning the non-SSR response, otherwise
		// SvelteKit will erroneously believe that the path has been prerendered,
		// causing functions to be omitted from the manifesst generated later
		const should_prerender = get_option(nodes, 'prerender') ?? false;
		if (should_prerender) {
			const mod = leaf_node.server;
			if (mod?.actions) {
				throw new Error('Cannot prerender pages with actions');
			}
		} else if (state.prerendering) {
			// if the page isn't marked as prerenderable, then bail out at this point
			return new Response(undefined, {
				status: 204
			});
		}

		// if we fetch any endpoints while loading data for this page, they should
		// inherit the prerender option of the page
		state.prerender_default = should_prerender;

		/** @type {import('./types').Fetched[]} */
		const fetched = [];

		if (get_option(nodes, 'ssr') === false) {
			return await render_response({
				branch: [],
				fetched,
				page_config: {
					ssr: false,
					csr: get_option(nodes, 'csr') ?? true
				},
				status,
				error: null,
				event,
				options,
				manifest,
				state,
				resolve_opts
			});
		}

		/** @type {Array<import('./types.js').Loaded | null>} */
		let branch = [];

		/** @type {Error | null} */
		let load_error = null;

		/** @type {Array<Promise<import('types').ServerDataNode | null>>} */
		const server_promises = nodes.map((node, i) => {
			if (load_error) {
				// if an error happens immediately, don't bother with the rest of the nodes
				throw load_error;
			}

			return Promise.resolve().then(async () => {
				try {
					if (node === leaf_node && action_result?.type === 'error') {
						// we wait until here to throw the error so that we can use
						// any nested +error.svelte components that were defined
						throw action_result.error;
					}

					return await load_server_data({
						event,
						state,
						node,
						parent: async () => {
							/** @type {Record<string, any>} */
							const data = {};
							for (let j = 0; j < i; j += 1) {
								const parent = await server_promises[j];
								if (parent) Object.assign(data, await parent.data);
							}
							return data;
						}
					});
				} catch (e) {
					load_error = /** @type {Error} */ (e);
					throw load_error;
				}
			});
		});

		const csr = get_option(nodes, 'csr') ?? true;

		/** @type {Array<Promise<Record<string, any> | null>>} */
		const load_promises = nodes.map((node, i) => {
			if (load_error) throw load_error;
			return Promise.resolve().then(async () => {
				try {
					return await load_data({
						event,
						fetched,
						node,
						parent: async () => {
							const data = {};
							for (let j = 0; j < i; j += 1) {
								Object.assign(data, await load_promises[j]);
							}
							return data;
						},
						resolve_opts,
						server_data_promise: server_promises[i],
						state,
						csr
					});
				} catch (e) {
					load_error = /** @type {Error} */ (e);
					throw load_error;
				}
			});
		});

		// if we don't do this, rejections will be unhandled
		for (const p of server_promises) p.catch(() => {});
		for (const p of load_promises) p.catch(() => {});

		for (let i = 0; i < nodes.length; i += 1) {
			const node = nodes[i];

			if (node) {
				try {
					const server_data = await server_promises[i];
					const data = await load_promises[i];

					branch.push({ node, server_data, data });
				} catch (e) {
					const err = normalize_error(e);

					if (err instanceof Redirect) {
						if (state.prerendering && should_prerender_data) {
							const body = JSON.stringify({
								type: 'redirect',
								location: err.location
							});

							state.prerendering.dependencies.set(data_pathname, {
								response: text(body),
								body
							});
						}

						return redirect_response(err.status, err.location);
					}

					const status = err instanceof HttpError ? err.status : 500;
					const error = await handle_error_and_jsonify(event, options, err);

					while (i--) {
						if (page.errors[i]) {
							const index = /** @type {number} */ (page.errors[i]);
							const node = await manifest._.nodes[index]();

							let j = i;
							while (!branch[j]) j -= 1;

							return await render_response({
								event,
								options,
								manifest,
								state,
								resolve_opts,
								page_config: { ssr: true, csr: true },
								status,
								error,
								branch: compact(branch.slice(0, j + 1)).concat({
									node,
									data: null,
									server_data: null
								}),
								fetched
							});
						}
					}

					// if we're still here, it means the error happened in the root layout,
					// which means we have to fall back to error.html
					return static_error_page(options, status, error.message);
				}
			} else {
				// push an empty slot so we can rewind past gaps to the
				// layout that corresponds with an +error.svelte page
				branch.push(null);
			}
		}

		if (state.prerendering && should_prerender_data) {
			// ndjson format
			let { data, chunks } = get_data_json(
				event,
				options,
				branch.map((node) => node?.server_data)
			);

			if (chunks) {
				for await (const chunk of chunks) {
					data += chunk;
				}
			}

			state.prerendering.dependencies.set(data_pathname, {
				response: text(data),
				body: data
			});
		}

		return await render_response({
			event,
			options,
			manifest,
			state,
			resolve_opts,
			page_config: {
				csr: get_option(nodes, 'csr') ?? true,
				ssr: true
			},
			status,
			error: null,
			branch: compact(branch),
			action_result,
			fetched
		});
	} catch (e) {
		// if we end up here, it means the data loaded successfully
		// but the page failed to render, or that a prerendering error occurred
		return await respond_with_error({
			event,
			options,
			manifest,
			state,
			status: 500,
			error: e,
			resolve_opts
		});
	}
}

/**
 * @param {RegExpMatchArray} match
 * @param {import('types').RouteParam[]} params
 * @param {Record<string, import('types').ParamMatcher>} matchers
 */
function exec(match, params, matchers) {
	/** @type {Record<string, string>} */
	const result = {};

	const values = match.slice(1);

	let buffered = 0;

	for (let i = 0; i < params.length; i += 1) {
		const param = params[i];
		const value = values[i - buffered];

		// in the `[[a=b]]/.../[...rest]` case, if one or more optional parameters
		// weren't matched, roll the skipped values into the rest
		if (param.chained && param.rest && buffered) {
			result[param.name] = values
				.slice(i - buffered, i + 1)
				.filter((s) => s)
				.join('/');

			buffered = 0;
			continue;
		}

		// if `value` is undefined, it means this is an optional or rest parameter
		if (value === undefined) {
			if (param.rest) result[param.name] = '';
			continue;
		}

		if (!param.matcher || matchers[param.matcher](value)) {
			result[param.name] = value;

			// Now that the params match, reset the buffer if the next param isn't the [...rest]
			// and the next value is defined, otherwise the buffer will cause us to skip values
			const next_param = params[i + 1];
			const next_value = values[i + 1];
			if (next_param && !next_param.rest && next_param.optional && next_value) {
				buffered = 0;
			}
			continue;
		}

		// in the `/[[a=b]]/...` case, if the value didn't satisfy the matcher,
		// keep track of the number of skipped optional parameters and continue
		if (param.optional && param.chained) {
			buffered++;
			continue;
		}

		// otherwise, if the matcher returns `false`, the route did not match
		return;
	}

	if (buffered) return;
	return result;
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {import('types').TrailingSlash} trailing_slash
 */
function get_cookies(request, url, trailing_slash) {
	const header = request.headers.get('cookie') ?? '';
	const initial_cookies = parse(header, { decode: (value) => value });

	const normalized_url = normalize_path(url.pathname, trailing_slash);
	// Emulate browser-behavior: if the cookie is set at '/foo/bar', its path is '/foo'
	const default_path = normalized_url.split('/').slice(0, -1).join('/') || '/';

	/** @type {Record<string, import('./page/types').Cookie>} */
	const new_cookies = {};

	/** @type {import('cookie').CookieSerializeOptions} */
	const defaults = {
		httpOnly: true,
		sameSite: 'lax',
		secure: url.hostname === 'localhost' && url.protocol === 'http:' ? false : true
	};

	/** @type {import('types').Cookies} */
	const cookies = {
		// The JSDoc param annotations appearing below for get, set and delete
		// are necessary to expose the `cookie` library types to
		// typescript users. `@type {import('types').Cookies}` above is not
		// sufficient to do so.

		/**
		 * @param {string} name
		 * @param {import('cookie').CookieParseOptions} opts
		 */
		get(name, opts) {
			const c = new_cookies[name];
			if (
				c &&
				domain_matches(url.hostname, c.options.domain) &&
				path_matches(url.pathname, c.options.path)
			) {
				return c.value;
			}

			const decoder = opts?.decode || decodeURIComponent;
			const req_cookies = parse(header, { decode: decoder });
			const cookie = req_cookies[name]; // the decoded string or undefined

			return cookie;
		},

		/**
		 * @param {import('cookie').CookieParseOptions} opts
		 */
		getAll(opts) {
			const decoder = opts?.decode || decodeURIComponent;
			const cookies = parse(header, { decode: decoder });

			for (const c of Object.values(new_cookies)) {
				if (
					domain_matches(url.hostname, c.options.domain) &&
					path_matches(url.pathname, c.options.path)
				) {
					cookies[c.name] = c.value;
				}
			}

			return Object.entries(cookies).map(([name, value]) => ({ name, value }));
		},

		/**
		 * @param {string} name
		 * @param {string} value
		 * @param {import('cookie').CookieSerializeOptions} opts
		 */
		set(name, value, opts = {}) {
			let path = opts.path ?? default_path;

			new_cookies[name] = {
				name,
				value,
				options: {
					...defaults,
					...opts,
					path
				}
			};
		},

		/**
		 * @param {string} name
		 * @param {import('cookie').CookieSerializeOptions} opts
		 */
		delete(name, opts = {}) {
			cookies.set(name, '', {
				...opts,
				maxAge: 0
			});
		},

		/**
		 * @param {string} name
		 * @param {string} value
		 * @param {import('cookie').CookieSerializeOptions} opts
		 */
		serialize(name, value, opts) {
			return serialize(name, value, {
				...defaults,
				...opts
			});
		}
	};

	/**
	 * @param {URL} destination
	 * @param {string | null} header
	 */
	function get_cookie_header(destination, header) {
		/** @type {Record<string, string>} */
		const combined_cookies = {
			// cookies sent by the user agent have lowest precedence
			...initial_cookies
		};

		// cookies previous set during this event with cookies.set have higher precedence
		for (const key in new_cookies) {
			const cookie = new_cookies[key];
			if (!domain_matches(destination.hostname, cookie.options.domain)) continue;
			if (!path_matches(destination.pathname, cookie.options.path)) continue;

			const encoder = cookie.options.encode || encodeURIComponent;
			combined_cookies[cookie.name] = encoder(cookie.value);
		}

		// explicit header has highest precedence
		if (header) {
			const parsed = parse(header, { decode: (value) => value });
			for (const name in parsed) {
				combined_cookies[name] = parsed[name];
			}
		}

		return Object.entries(combined_cookies)
			.map(([name, value]) => `${name}=${value}`)
			.join('; ');
	}

	return { cookies, new_cookies, get_cookie_header };
}

/**
 * @param {string} hostname
 * @param {string} [constraint]
 */
function domain_matches(hostname, constraint) {
	if (!constraint) return true;

	const normalized = constraint[0] === '.' ? constraint.slice(1) : constraint;

	if (hostname === normalized) return true;
	return hostname.endsWith('.' + normalized);
}

/**
 * @param {string} path
 * @param {string} [constraint]
 */
function path_matches(path, constraint) {
	if (!constraint) return true;

	const normalized = constraint.endsWith('/') ? constraint.slice(0, -1) : constraint;

	if (path === normalized) return true;
	return path.startsWith(normalized + '/');
}

/**
 * @param {Headers} headers
 * @param {import('./page/types').Cookie[]} cookies
 */
function add_cookies_to_headers(headers, cookies) {
	for (const new_cookie of cookies) {
		const { name, value, options } = new_cookie;
		headers.append('set-cookie', serialize(name, value, options));
	}
}

/**
 * @param {{
 *   event: import('types').RequestEvent;
 *   options: import('types').SSROptions;
 *   manifest: import('types').SSRManifest;
 *   state: import('types').SSRState;
 *   get_cookie_header: (url: URL, header: string | null) => string;
 * }} opts
 * @returns {typeof fetch}
 */
function create_fetch({ event, options, manifest, state, get_cookie_header }) {
	return async (info, init) => {
		const original_request = normalize_fetch_input(info, init, event.url);

		// some runtimes (e.g. Cloudflare) error if you access `request.mode`,
		// annoyingly, so we need to read the value from the `init` object instead
		let mode = (info instanceof Request ? info.mode : init?.mode) ?? 'cors';
		let credentials =
			(info instanceof Request ? info.credentials : init?.credentials) ?? 'same-origin';

		return await options.hooks.handleFetch({
			event,
			request: original_request,
			fetch: async (info, init) => {
				const request = normalize_fetch_input(info, init, event.url);

				const url = new URL(request.url);

				if (!request.headers.has('origin')) {
					request.headers.set('origin', event.url.origin);
				}

				if (info !== original_request) {
					mode = (info instanceof Request ? info.mode : init?.mode) ?? 'cors';
					credentials =
						(info instanceof Request ? info.credentials : init?.credentials) ?? 'same-origin';
				}

				// Remove Origin, according to https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Origin#description
				if (
					(request.method === 'GET' || request.method === 'HEAD') &&
					((mode === 'no-cors' && url.origin !== event.url.origin) ||
						url.origin === event.url.origin)
				) {
					request.headers.delete('origin');
				}

				if (url.origin !== event.url.origin) {
					// allow cookie passthrough for "same-origin"
					// if SvelteKit is serving my.domain.com:
					// -        domain.com WILL NOT receive cookies
					// -     my.domain.com WILL receive cookies
					// -    api.domain.dom WILL NOT receive cookies
					// - sub.my.domain.com WILL receive cookies
					// ports do not affect the resolution
					// leading dot prevents mydomain.com matching domain.com
					if (`.${url.hostname}`.endsWith(`.${event.url.hostname}`) && credentials !== 'omit') {
						const cookie = get_cookie_header(url, request.headers.get('cookie'));
						if (cookie) request.headers.set('cookie', cookie);
					}

					return fetch(request);
				}

				/** @type {Response} */
				let response;

				// handle fetch requests for static assets. e.g. prebaked data, etc.
				// we need to support everything the browser's fetch supports
				const prefix = assets || base;
				const decoded = decodeURIComponent(url.pathname);
				const filename = (
					decoded.startsWith(prefix) ? decoded.slice(prefix.length) : decoded
				).slice(1);
				const filename_html = `${filename}/index.html`; // path may also match path/index.html

				const is_asset = manifest.assets.has(filename);
				const is_asset_html = manifest.assets.has(filename_html);

				if (is_asset || is_asset_html) {
					const file = is_asset ? filename : filename_html;

					if (state.read) {
						const type = is_asset
							? manifest.mimeTypes[filename.slice(filename.lastIndexOf('.'))]
							: 'text/html';

						return new Response(state.read(file), {
							headers: type ? { 'content-type': type } : {}
						});
					}

					return await fetch(request);
				}

				if (credentials !== 'omit') {
					const cookie = get_cookie_header(url, request.headers.get('cookie'));
					if (cookie) {
						request.headers.set('cookie', cookie);
					}

					const authorization = event.request.headers.get('authorization');
					if (authorization && !request.headers.has('authorization')) {
						request.headers.set('authorization', authorization);
					}
				}

				if (!request.headers.has('accept')) {
					request.headers.set('accept', '*/*');
				}

				if (!request.headers.has('accept-language')) {
					request.headers.set(
						'accept-language',
						/** @type {string} */ (event.request.headers.get('accept-language'))
					);
				}

				response = await respond(request, options, manifest, {
					...state,
					depth: state.depth + 1
				});

				const set_cookie = response.headers.get('set-cookie');
				if (set_cookie) {
					for (const str of set_cookie_parser.splitCookiesString(set_cookie)) {
						const { name, value, ...options } = set_cookie_parser.parseString(str);

						// options.sameSite is string, something more specific is required - type cast is safe
						event.cookies.set(
							name,
							value,
							/** @type {import('cookie').CookieSerializeOptions} */ (options)
						);
					}
				}

				return response;
			}
		});
	};
}

/**
 * @param {RequestInfo | URL} info
 * @param {RequestInit | undefined} init
 * @param {URL} url
 */
function normalize_fetch_input(info, init, url) {
	if (info instanceof Request) {
		return info;
	}

	return new Request(typeof info === 'string' ? new URL(info, url) : info, init);
}

/**
 * @param {Set<string>} expected
 */
function validator(expected) {
	/**
	 * @param {any} module
	 * @param {string} [file]
	 */
	function validate(module, file) {
		if (!module) return;

		for (const key in module) {
			if (key[0] === '_' || expected.has(key)) continue; // key is valid in this module

			const values = [...expected.values()];

			const hint =
				hint_for_supported_files(key, file?.slice(file.lastIndexOf('.'))) ??
				`valid exports are ${values.join(', ')}, or anything with a '_' prefix`;

			throw new Error(`Invalid export '${key}'${file ? ` in ${file}` : ''} (${hint})`);
		}
	}

	return validate;
}

/**
 * @param {string} key
 * @param {string} ext
 * @returns {string | void}
 */
function hint_for_supported_files(key, ext = '.js') {
	let supported_files = [];

	if (valid_layout_exports.has(key)) {
		supported_files.push(`+layout${ext}`);
	}

	if (valid_page_exports.has(key)) {
		supported_files.push(`+page${ext}`);
	}

	if (valid_layout_server_exports.has(key)) {
		supported_files.push(`+layout.server${ext}`);
	}

	if (valid_page_server_exports.has(key)) {
		supported_files.push(`+page.server${ext}`);
	}

	if (valid_server_exports.has(key)) {
		supported_files.push(`+server${ext}`);
	}

	if (supported_files.length > 0) {
		return `'${key}' is a valid export in ${supported_files.slice(0, -1).join(`, `)}${
			supported_files.length > 1 ? ' or ' : ''
		}${supported_files.at(-1)}`;
	}
}

const valid_layout_exports = new Set([
	'load',
	'prerender',
	'csr',
	'ssr',
	'trailingSlash',
	'config'
]);
const valid_page_exports = new Set([...valid_layout_exports, 'entries']);
const valid_layout_server_exports = new Set([...valid_layout_exports, 'actions']);
const valid_page_server_exports = new Set([...valid_layout_server_exports, 'entries']);
const valid_server_exports = new Set([
	'GET',
	'POST',
	'PATCH',
	'PUT',
	'DELETE',
	'OPTIONS',
	'prerender',
	'trailingSlash',
	'config',
	'entries'
]);

const validate_layout_exports = validator(valid_layout_exports);
const validate_page_exports = validator(valid_page_exports);
const validate_layout_server_exports = validator(valid_layout_server_exports);
const validate_page_server_exports = validator(valid_page_server_exports);
const validate_server_exports = validator(valid_server_exports);

/* global "@sveltejs/adapter-vercel" */

/** @type {import('types').RequiredResolveOptions['transformPageChunk']} */
const default_transform = ({ html }) => html;

/** @type {import('types').RequiredResolveOptions['filterSerializedResponseHeaders']} */
const default_filter = () => false;

/** @type {import('types').RequiredResolveOptions['preload']} */
const default_preload = ({ type }) => type === 'js' || type === 'css';

/**
 * @param {Request} request
 * @param {import('types').SSROptions} options
 * @param {import('types').SSRManifest} manifest
 * @param {import('types').SSRState} state
 * @returns {Promise<Response>}
 */
async function respond(request, options, manifest, state) {
	/** URL but stripped from the potential `/__data.json` suffix and its search param  */
	let url = new URL(request.url);

	if (options.csrf_check_origin) {
		const forbidden =
			is_form_content_type(request) &&
			(request.method === 'POST' ||
				request.method === 'PUT' ||
				request.method === 'PATCH' ||
				request.method === 'DELETE') &&
			request.headers.get('origin') !== url.origin;

		if (forbidden) {
			const csrf_error = error(403, `Cross-site ${request.method} form submissions are forbidden`);
			if (request.headers.get('accept') === 'application/json') {
				return json(csrf_error.body, { status: csrf_error.status });
			}
			return text(csrf_error.body.message, { status: csrf_error.status });
		}
	}

	let decoded;
	try {
		decoded = decode_pathname(url.pathname);
	} catch {
		return text('Malformed URI', { status: 400 });
	}

	/** @type {import('types').SSRRoute | null} */
	let route = null;

	/** @type {Record<string, string>} */
	let params = {};

	if (base && !state.prerendering?.fallback) {
		if (!decoded.startsWith(base)) {
			return text('Not found', { status: 404 });
		}
		decoded = decoded.slice(base.length) || '/';
	}

	const is_data_request = has_data_suffix(decoded);
	/** @type {boolean[] | undefined} */
	let invalidated_data_nodes;
	if (is_data_request) {
		decoded = strip_data_suffix(decoded) || '/';
		url.pathname = strip_data_suffix(url.pathname) || '/';
		invalidated_data_nodes = url.searchParams
			.get(INVALIDATED_PARAM)
			?.split('')
			.map((node) => node === '1');
		url.searchParams.delete(INVALIDATED_PARAM);
	}

	if (!state.prerendering?.fallback) {
		// TODO this could theoretically break — should probably be inside a try-catch
		const matchers = await manifest._.matchers();

		for (const candidate of manifest._.routes) {
			const match = candidate.pattern.exec(decoded);
			if (!match) continue;

			const matched = exec(match, candidate.params, matchers);
			if (matched) {
				route = candidate;
				params = decode_params(matched);
				break;
			}
		}
	}

	/** @type {import('types').TrailingSlash | void} */
	let trailing_slash = undefined;

	/** @type {Record<string, string>} */
	const headers = {};

	/** @type {Record<string, import('./page/types').Cookie>} */
	let cookies_to_add = {};

	/** @type {import('types').RequestEvent} */
	const event = {
		// @ts-expect-error `cookies` and `fetch` need to be created after the `event` itself
		cookies: null,
		// @ts-expect-error
		fetch: null,
		getClientAddress:
			state.getClientAddress ||
			(() => {
				throw new Error(
					`${"@sveltejs/adapter-vercel"} does not specify getClientAddress. Please raise an issue`
				);
			}),
		locals: {},
		params,
		platform: state.platform,
		request,
		route: { id: route?.id ?? null },
		setHeaders: (new_headers) => {
			for (const key in new_headers) {
				const lower = key.toLowerCase();
				const value = new_headers[key];

				if (lower === 'set-cookie') {
					throw new Error(
						`Use \`event.cookies.set(name, value, options)\` instead of \`event.setHeaders\` to set cookies`
					);
				} else if (lower in headers) {
					throw new Error(`"${key}" header is already set`);
				} else {
					headers[lower] = value;

					if (state.prerendering && lower === 'cache-control') {
						state.prerendering.cache = /** @type {string} */ (value);
					}
				}
			}
		},
		url,
		isDataRequest: is_data_request
	};

	/** @type {import('types').RequiredResolveOptions} */
	let resolve_opts = {
		transformPageChunk: default_transform,
		filterSerializedResponseHeaders: default_filter,
		preload: default_preload
	};

	try {
		// determine whether we need to redirect to add/remove a trailing slash
		if (route) {
			// if `paths.base === '/a/b/c`, then the root route is `/a/b/c/`,
			// regardless of the `trailingSlash` route option
			if (url.pathname === base || url.pathname === base + '/') {
				trailing_slash = 'always';
			} else if (route.page) {
				const nodes = await Promise.all([
					// we use == here rather than === because [undefined] serializes as "[null]"
					...route.page.layouts.map((n) => (n == undefined ? n : manifest._.nodes[n]())),
					manifest._.nodes[route.page.leaf]()
				]);

				if (DEV) ;

				trailing_slash = get_option(nodes, 'trailingSlash');
			} else if (route.endpoint) {
				const node = await route.endpoint();
				trailing_slash = node.trailingSlash;

				if (DEV) ;
			}

			if (!is_data_request) {
				const normalized = normalize_path(url.pathname, trailing_slash ?? 'never');

				if (normalized !== url.pathname && !state.prerendering?.fallback) {
					return new Response(undefined, {
						status: 308,
						headers: {
							'x-sveltekit-normalize': '1',
							location:
								// ensure paths starting with '//' are not treated as protocol-relative
								(normalized.startsWith('//') ? url.origin + normalized : normalized) +
								(url.search === '?' ? '' : url.search)
						}
					});
				}
			}
		}

		const { cookies, new_cookies, get_cookie_header } = get_cookies(
			request,
			url,
			trailing_slash ?? 'never'
		);

		cookies_to_add = new_cookies;
		event.cookies = cookies;
		event.fetch = create_fetch({ event, options, manifest, state, get_cookie_header });

		if (state.prerendering && !state.prerendering.fallback) disable_search(url);

		const response = await options.hooks.handle({
			event,
			resolve: (event, opts) =>
				resolve(event, opts).then((response) => {
					// add headers/cookies here, rather than inside `resolve`, so that we
					// can do it once for all responses instead of once per `return`
					for (const key in headers) {
						const value = headers[key];
						response.headers.set(key, /** @type {string} */ (value));
					}

					add_cookies_to_headers(response.headers, Object.values(cookies_to_add));

					if (state.prerendering && event.route.id !== null) {
						response.headers.set('x-sveltekit-routeid', encodeURI(event.route.id));
					}

					return response;
				})
		});

		// respond with 304 if etag matches
		if (response.status === 200 && response.headers.has('etag')) {
			let if_none_match_value = request.headers.get('if-none-match');

			// ignore W/ prefix https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match#directives
			if (if_none_match_value?.startsWith('W/"')) {
				if_none_match_value = if_none_match_value.substring(2);
			}

			const etag = /** @type {string} */ (response.headers.get('etag'));

			if (if_none_match_value === etag) {
				const headers = new Headers({ etag });

				// https://datatracker.ietf.org/doc/html/rfc7232#section-4.1 + set-cookie
				for (const key of [
					'cache-control',
					'content-location',
					'date',
					'expires',
					'vary',
					'set-cookie'
				]) {
					const value = response.headers.get(key);
					if (value) headers.set(key, value);
				}

				return new Response(undefined, {
					status: 304,
					headers
				});
			}
		}

		// Edge case: If user does `return Response(30x)` in handle hook while processing a data request,
		// we need to transform the redirect response to a corresponding JSON response.
		if (is_data_request && response.status >= 300 && response.status <= 308) {
			const location = response.headers.get('location');
			if (location) {
				return redirect_json_response(new Redirect(/** @type {any} */ (response.status), location));
			}
		}

		return response;
	} catch (e) {
		if (e instanceof Redirect) {
			const response = is_data_request
				? redirect_json_response(e)
				: route?.page && is_action_json_request(event)
				? action_json_redirect(e)
				: redirect_response(e.status, e.location);
			add_cookies_to_headers(response.headers, Object.values(cookies_to_add));
			return response;
		}
		return await handle_fatal_error(event, options, e);
	}

	/**
	 *
	 * @param {import('types').RequestEvent} event
	 * @param {import('types').ResolveOptions} [opts]
	 */
	async function resolve(event, opts) {
		try {
			if (opts) {
				if ('ssr' in opts) {
					throw new Error(
						'ssr has been removed, set it in the appropriate +layout.js instead. See the PR for more information: https://github.com/sveltejs/kit/pull/6197'
					);
				}

				resolve_opts = {
					transformPageChunk: opts.transformPageChunk || default_transform,
					filterSerializedResponseHeaders: opts.filterSerializedResponseHeaders || default_filter,
					preload: opts.preload || default_preload
				};
			}

			if (state.prerendering?.fallback) {
				return await render_response({
					event,
					options,
					manifest,
					state,
					page_config: { ssr: false, csr: true },
					status: 200,
					error: null,
					branch: [],
					fetched: [],
					resolve_opts
				});
			}

			if (route) {
				/** @type {Response} */
				let response;

				if (is_data_request) {
					response = await render_data(
						event,
						route,
						options,
						manifest,
						state,
						invalidated_data_nodes,
						trailing_slash ?? 'never'
					);
				} else if (route.endpoint && (!route.page || is_endpoint_request(event))) {
					response = await render_endpoint(event, await route.endpoint(), state);
				} else if (route.page) {
					response = await render_page(event, route.page, options, manifest, state, resolve_opts);
				} else {
					// a route will always have a page or an endpoint, but TypeScript
					// doesn't know that
					throw new Error('This should never happen');
				}

				return response;
			}

			if (state.error) {
				return text('Internal Server Error', {
					status: 500
				});
			}

			// if this request came direct from the user, rather than
			// via our own `fetch`, render a 404 page
			if (state.depth === 0) {
				return await respond_with_error({
					event,
					options,
					manifest,
					state,
					status: 404,
					error: new Error(`Not found: ${event.url.pathname}`),
					resolve_opts
				});
			}

			if (state.prerendering) {
				return text('not found', { status: 404 });
			}

			// we can't load the endpoint from our own manifest,
			// so we need to make an actual HTTP request
			return await fetch(request);
		} catch (e) {
			// TODO if `e` is instead named `error`, some fucked up Vite transformation happens
			// and I don't even know how to describe it. need to investigate at some point

			// HttpError from endpoint can end up here - TODO should it be handled there instead?
			return await handle_fatal_error(event, options, e);
		} finally {
			event.cookies.set = () => {
				throw new Error('Cannot use `cookies.set(...)` after the response has been generated');
			};

			event.setHeaders = () => {
				throw new Error('Cannot use `setHeaders(...)` after the response has been generated');
			};
		}
	}
}

class Server {
	/** @type {import('types').SSROptions} */
	#options;

	/** @type {import('types').SSRManifest} */
	#manifest;

	/** @param {import('types').SSRManifest} manifest */
	constructor(manifest) {
		/** @type {import('types').SSROptions} */
		this.#options = options;
		this.#manifest = manifest;
	}

	/**
	 * @param {{
	 *   env: Record<string, string>
	 * }} opts
	 */
	async init({ env }) {
		// Take care: Some adapters may have to call `Server.init` per-request to set env vars,
		// so anything that shouldn't be rerun should be wrapped in an `if` block to make sure it hasn't
		// been done already.
		const entries = Object.entries(env);

		const prefix = this.#options.env_public_prefix;
		Object.fromEntries(entries.filter(([k]) => !k.startsWith(prefix)));
		const pub = Object.fromEntries(entries.filter(([k]) => k.startsWith(prefix)));
		set_public_env(pub);

		if (!this.#options.hooks) {
			try {
				const module = await get_hooks();

				this.#options.hooks = {
					handle: module.handle || (({ event, resolve }) => resolve(event)),
					handleError: module.handleError || (({ error }) => console.error(error)),
					handleFetch: module.handleFetch || (({ request, fetch }) => fetch(request))
				};
			} catch (error) {
				{
					throw error;
				}
			}
		}
	}

	/**
	 * @param {Request} request
	 * @param {import('types').RequestOptions} options
	 */
	async respond(request, options) {
		// TODO this should probably have been removed for 1.0 — i think we can get rid of it?
		if (!(request instanceof Request)) {
			throw new Error(
				'The first argument to server.respond must be a Request object. See https://github.com/sveltejs/kit/pull/3384 for details'
			);
		}

		return respond(request, this.#options, this.#manifest, {
			...options,
			error: false,
			depth: 0
		});
	}
}

export { Server };
