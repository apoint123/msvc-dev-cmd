import { defineConfig } from "tsdown";

export default defineConfig({
	dts: false,
	copy: ["./action.yml", "./package.json"],
	deps: {
		alwaysBundle: [/@actions/],
	},
});
