import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				isolatedStorage: false,
				singleWorker: true,
				miniflare: {
					durableObjectsPersist: false,
				},
				wrangler: { configPath: "./wrangler.jsonc" },
			},
		},
	},
});
