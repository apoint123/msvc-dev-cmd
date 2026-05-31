import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import * as core from "@actions/core";

const PROGRAM_FILES_X86 = process.env["ProgramFiles(x86)"] ?? "";
const PROGRAM_FILES = [
	process.env["ProgramFiles(x86)"],
	process.env.ProgramFiles,
].filter((p) => p !== undefined);

const EDITIONS = ["Enterprise", "Professional", "Community", "BuildTools"];
const YEARS = ["2026", "2022", "2019", "2017"];

const VsYearVersion: Record<number | string, string> = {
	2026: "18.0",
	2022: "17.0",
	2019: "16.0",
	2017: "15.0",
	2015: "14.0",
	2013: "12.0",
};

export function vsversion_to_versionnumber(vsversion: string): string {
	if (Object.values(VsYearVersion).includes(vsversion)) {
		return vsversion;
	} else {
		if (vsversion in VsYearVersion) {
			return VsYearVersion[vsversion];
		}
	}
	return vsversion;
}

export function vsversion_to_year(vsversion: string): string {
	if (Object.keys(VsYearVersion).includes(vsversion)) {
		return vsversion;
	} else {
		for (const [year, ver] of Object.entries(VsYearVersion)) {
			if (ver === vsversion) {
				return year;
			}
		}
	}
	return vsversion;
}

const VSWHERE_PATH = `${PROGRAM_FILES_X86}\\Microsoft Visual Studio\\Installer`;

export function findWithVswhere(
	pattern: string,
	version_pattern: string,
): string | null {
	try {
		const installationPath = child_process
			.execSync(
				`vswhere -products * ${version_pattern} -prerelease -property installationPath`,
			)
			.toString()
			.trim();
		return `${installationPath}\\${pattern}`;
	} catch (e) {
		core.warning(`vswhere failed: ${e}`);
	}
	return null;
}

export function findVcvarsall(vsversion?: string): string {
	const vsversion_number = vsversion
		? vsversion_to_versionnumber(vsversion)
		: undefined;
	let version_pattern: string;
	if (vsversion_number) {
		const upper_bound = `${vsversion_number.split(".")[0]}.9`;
		version_pattern = `-version "${vsversion_number},${upper_bound}"`;
	} else {
		version_pattern = "-latest";
	}

	// If vswhere is available, ask it about the location of the latest Visual Studio.
	let foundPath = findWithVswhere(
		"VC\\Auxiliary\\Build\\vcvarsall.bat",
		version_pattern,
	);
	if (foundPath && fs.existsSync(foundPath)) {
		core.info(`Found with vswhere: ${foundPath}`);
		return foundPath;
	}
	core.info("Not found with vswhere");

	// If that does not work, try the standard installation locations,
	// starting with the latest and moving to the oldest.
	const years = vsversion ? [vsversion_to_year(vsversion)] : YEARS;
	for (const prog_files of PROGRAM_FILES) {
		for (const ver of years) {
			for (const ed of EDITIONS) {
				foundPath = `${prog_files}\\Microsoft Visual Studio\\${ver}\\${ed}\\VC\\Auxiliary\\Build\\vcvarsall.bat`;
				core.info(`Trying standard location: ${foundPath}`);
				if (fs.existsSync(foundPath)) {
					core.info(`Found standard location: ${foundPath}`);
					return foundPath;
				}
			}
		}
	}
	core.info("Not found in standard locations");

	// Special case for Visual Studio 2015 (and maybe earlier), try it out too.
	foundPath = `${PROGRAM_FILES_X86}\\Microsoft Visual C++ Build Tools\\vcbuildtools.bat`;
	if (fs.existsSync(foundPath)) {
		core.info(`Found VS 2015: ${foundPath}`);
		return foundPath;
	}
	core.info(`Not found in VS 2015 location: ${foundPath}`);

	throw new Error("Microsoft Visual Studio not found");
}

function isPathVariable(name: string): boolean {
	const pathLikeVariables = ["PATH", "INCLUDE", "LIB", "LIBPATH"];
	return pathLikeVariables.indexOf(name.toUpperCase()) !== -1;
}

function filterPathValue(pathString: string): string {
	const paths = pathString.split(";");
	// Remove duplicates by keeping the first occurance and preserving order.
	// This keeps path shadowing working as intended.
	function unique(value: string, index: number, self: string[]): boolean {
		return self.indexOf(value) === index;
	}
	return paths.filter(unique).join(";");
}

/** See https://github.com/ilammy/msvc-dev-cmd#inputs */
export function setupMSVCDevCmd(
	arch: string,
	sdk?: string,
	toolset?: string,
	uwp?: string,
	spectre?: string,
	vsversion?: string,
): void {
	if (process.platform !== "win32") {
		core.info("This is not a Windows virtual environment, bye!");
		return;
	}

	// Add standard location of "vswhere" to PATH, in case it's not there.
	process.env.PATH += path.delimiter + VSWHERE_PATH;

	// There are all sorts of way the architectures are called. In addition to
	// values supported by Microsoft Visual C++, recognize some common aliases.
	const arch_aliases: Record<string, string> = {
		win32: "x86",
		win64: "x64",
		x86_64: "x64",
		"x86-64": "x64",
	};
	// Ignore case when matching as that's what humans expect.
	if (arch.toLowerCase() in arch_aliases) {
		arch = arch_aliases[arch.toLowerCase()];
	}

	// Due to the way Microsoft Visual C++ is configured, we have to resort to the following hack:
	// Call the configuration batch file and then output *all* the environment variables.

	const args = [arch];
	if (uwp === "true") {
		args.push("uwp");
	}
	if (sdk) {
		args.push(sdk);
	}
	if (toolset) {
		args.push(`-vcvars_ver=${toolset}`);
	}
	if (spectre === "true") {
		args.push("-vcvars_spectre_libs=spectre");
	}

	const vcvars = `"${findVcvarsall(vsversion)}" ${args.join(" ")}`;
	core.debug(`vcvars command-line: ${vcvars}`);

	const cmd_output_string = child_process
		.execSync(`set && cls && ${vcvars} && cls && set`, { shell: "cmd" })
		.toString();
	const cmd_output_parts = cmd_output_string.split("\f");

	const old_environment = cmd_output_parts[0].split("\r\n");
	const vcvars_output = cmd_output_parts[1].split("\r\n");
	const new_environment = cmd_output_parts[2].split("\r\n");

	// If vsvars.bat is given an incorrect command line, it will print out
	// an error and *still* exit successfully. Parse out errors from output
	// which don't look like environment variables, and fail if appropriate.
	const error_messages = vcvars_output.filter((line) => {
		if (line.match(/^\[ERROR.*\]/)) {
			// Don't print this particular line which will be confusing in output.
			if (!line.match(/Error in script usage. The correct usage is:$/)) {
				return true;
			}
		}
		return false;
	});
	if (error_messages.length > 0) {
		throw new Error(`invalid parameters\r\n${error_messages.join("\r\n")}`);
	}

	// Convert old environment lines into a dictionary for easier lookup.
	const old_env_vars: Record<string, string> = {};
	for (const string of old_environment) {
		const [name, value] = string.split("=");
		if (name) {
			old_env_vars[name] = value;
		}
	}

	// Now look at the new environment and export everything that changed.
	// These are the variables set by vsvars.bat. Also export everything
	// that was not there during the first sweep: those are new variables.
	core.startGroup("Environment variables");
	for (const string of new_environment) {
		// vsvars.bat likes to print some fluff at the beginning.
		// Skip lines that don't look like environment variables.
		if (!string.includes("=")) {
			continue;
		}
		let [name, new_value] = string.split("=");
		const old_value = old_env_vars[name];
		// For new variables "old_value === undefined".
		if (new_value !== old_value) {
			core.info(`Setting ${name}`);
			// Special case for a bunch of PATH-like variables: vcvarsall.bat
			// just prepends its stuff without checking if its already there.
			// This makes repeated invocations of this action fail after some
			// point, when the environment variable overflows. Avoid that.
			if (isPathVariable(name)) {
				new_value = filterPathValue(new_value);
			}
			core.exportVariable(name, new_value);
		}
	}
	core.endGroup();

	core.info(`Configured Developer Command Prompt`);
}
