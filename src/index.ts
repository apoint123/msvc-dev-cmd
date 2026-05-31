import * as core from "@actions/core";
import { setupMSVCDevCmd } from "./lib.js";

function main(): void {
	const arch = core.getInput("arch");
	const sdk = core.getInput("sdk");
	const toolset = core.getInput("toolset");
	const uwp = core.getInput("uwp");
	const spectre = core.getInput("spectre");
	const vsversion = core.getInput("vsversion");

	setupMSVCDevCmd(arch, sdk, toolset, uwp, spectre, vsversion);
}

try {
	main();
} catch (e) {
	const message = e instanceof Error ? e.message : String(e);
	core.setFailed(`Could not setup Developer Command Prompt: ${message}`);
}
