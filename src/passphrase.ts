import { App, Modal, Notice, Setting } from "obsidian";
import type VLBPlugin from "./main";
import { hashPass, randomHex, safeEqual } from "./crypto";

const MIN_LENGTH = 4;

/**
 * Set the passphrase (first run) or change it (asks for the current one first).
 * This is the only thing a user has to do; the backup is configured by the setup script.
 */
export class PassphraseModal extends Modal {
	private busy = false;

	constructor(app: App, private plugin: VLBPlugin, private onSaved?: () => void) {
		super(app);
	}

	onOpen(): void {
		const s = this.plugin.settings;
		const changing = !!s.passHash;
		const { contentEl } = this;
		this.titleEl.setText(changing ? "Change passphrase" : "Choose a passphrase");
		contentEl.createEl("p", {
			text: changing
				? "Enter your current passphrase, then the new one twice."
				: "You will type it to unlock this vault. The vault locks when Obsidian starts and after a few idle minutes. Your notes are backed up automatically.",
		});

		let current = "", next = "", confirm = "";
		const inputs: HTMLInputElement[] = [];
		const field = (name: string, set: (v: string) => void) =>
			new Setting(contentEl).setName(name).addText((t) => {
				t.inputEl.type = "password";
				t.inputEl.autocomplete = "off";
				t.onChange(set);
				inputs.push(t.inputEl);
			});
		if (changing) field("Current passphrase", (v) => (current = v));
		field(changing ? "New passphrase" : "Passphrase", (v) => (next = v));
		field("Type it again", (v) => (confirm = v));

		const err = contentEl.createDiv({ cls: "vlb-error" });

		const save = async () => {
			if (this.busy) return;
			err.setText("");
			if (next.length < MIN_LENGTH) { err.setText(`Use at least ${MIN_LENGTH} characters.`); return; }
			if (next !== confirm) { err.setText("The two new passphrases are different."); return; }
			this.busy = true;
			try {
				if (changing && !safeEqual(await hashPass(current, s.passSalt), s.passHash)) {
					err.setText("The current passphrase is wrong.");
					return;
				}
				const salt = randomHex(16);
				s.passHash = await hashPass(next, salt);
				s.passSalt = salt;
				await this.plugin.saveSettings();
				this.plugin.backup.control.offerPassphrase(next);
			} finally {
				this.busy = false;
			}
			new Notice(changing ? "Passphrase changed." : "Passphrase saved. Don't forget it: you need it to unlock this vault.", 8000);
			this.close();
			this.onSaved?.();
		};

		const buttons = new Setting(contentEl);
		if (!changing) buttons.addButton((b) => b.setButtonText("Later").onClick(() => this.close()));
		buttons.addButton((b) => b.setButtonText("Save").setCta().onClick(() => void save()));

		for (const el of inputs) el.addEventListener("keydown", (e) => { if (e.key === "Enter") void save(); });
		window.setTimeout(() => inputs[0]?.focus(), 30);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
