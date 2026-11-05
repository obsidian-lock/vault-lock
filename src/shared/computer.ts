import * as os from "os";

/** This computer's name as the server shows it: "Laptop.local" -> "Laptop". */
export function computerName(): string {
	return safe(() => os.hostname().split(".")[0]) || "computer";
}

export function safe(f: () => string): string {
	try {
		return f();
	} catch {
		return "";
	}
}
