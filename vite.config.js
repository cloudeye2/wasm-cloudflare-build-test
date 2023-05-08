import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
	plugins: [
		sveltekit(),
		wasm(),
		topLevelAwait()
	],
	build: {
		rollupOptions: {
			plugins: [
				wasm(),topLevelAwait()
			],
		},
	},
	// build: {
	// 	rollupOptions: {
	// // Add a new loader to handle WebAssembly files
	// module: {
	// 		rules: [
	// {
	// 			test: /\.wasm$/,
	// 			type: 'webassembly/experimental',
	// 			loader: '@wasm-tool/webpack-loader',
	// },
	// 		],
	// },
	// 	},
	// },
	worker: {
	// Not needed with vite-plugin-top-level-await >= 1.3.0
	// format: "es",
	plugins: [
		wasm(),
		topLevelAwait()
	]
	}
});
