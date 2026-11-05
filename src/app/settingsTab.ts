import { Notice, Setting } from "obsidian";
import type { VaultLockApp } from "./app";
import type { Host } from "../shared/contract";
import { PassphraseModal } from "./passphrase";

/**
 * The body of the plugin's setting tab (the core owns the tab itself). Only the passphrase
 * and the lock. The backup pairs itself with the server and runs by itself; the server
 * changes its options through _control/config.json.
 */
export function renderSettings(el: HTMLElement, host: Host, owner: VaultLockApp): void {
	const s = host.settings;
	const redraw = () => { el.empty(); renderSettings(el, host, owner); };

	new Setting(el)
		.setName("Passphrase")
		.setDesc(s.passHash
			? "Needed to unlock the vault."
			: "Not set yet. Until you set one, the vault never locks and the private folder stays visible.")
		.addButton((b) => b.setButtonText(s.passHash ? "Change passphrase" : "Set passphrase").setCta()
			.onClick(() => new PassphraseModal(owner, redraw).open()));

	new Setting(el)
		.setName("Lock after idle (minutes)")
		.setDesc("0 disables the idle lock.")
		.addText((t) => t.setValue(String(s.idleMinutes)).onChange(async (v) => {
			if (v.trim() === "") return; // an emptied box while retyping is not "0"
			const n = Number(v);
			if (Number.isFinite(n) && n >= 0) { s.idleMinutes = n; await host.saveSettings(); }
		}));

	new Setting(el)
		.setName("Lock when the window loses focus")
		.addToggle((t) => t.setValue(s.lockOnBlur).onChange(async (v) => { s.lockOnBlur = v; await host.saveSettings(); }));

	new Setting(el)
		.setName("Private folder")
		.setDesc("Top-level folder that is renamed to a dot-folder (invisible to Obsidian) while locked. Change it only while unlocked.")
		.addText((t) => t.setValue(s.privateFolder).onChange(async (v) => {
			const name = v.trim();
			if (name.includes("/") || name.startsWith(".")) return;
			if (await host.app.vault.adapter.exists("." + s.privateFolder)) { new Notice("Unlock first — the current private folder is hidden."); return; }
			s.privateFolder = name;
			await host.saveSettings();
		}));
}
