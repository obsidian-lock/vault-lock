import { Modal } from "obsidian";
import type { App as ObsidianApp } from "obsidian";
import type { PrivateFolder } from "../shared/privateFolder";
import type { LockScreen } from "./lock";

/**
 * The padlock's dialog: the passphrase, then the private folder comes back. Esc or a click
 * outside closes it (Obsidian's default). Closing it while the folder is being decrypted does not
 * stop that: the folder appears when it is done and the padlock opens then.
 */
export class UnlockModal extends Modal {
	private resolveClosed: () => void = () => {};
	private readonly closed: Promise<void>;
	private progressFn: ((text: string | null) => void) | null = null;
	private isClosed = false;

	constructor(app: ObsidianApp, private lockScreen: LockScreen, private pf: PrivateFolder) {
		super(app);
		this.closed = new Promise<void>((r) => { this.resolveClosed = r; });
	}

	/** Resolves when the dialog closes (unlocked or dismissed). */
	openAndWait(): Promise<void> {
		this.open();
		return this.closed;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass("vlb-unlock");
		this.titleEl.setText("Unlock private folder");
		const input = contentEl.createEl("input", {
			type: "password",
			cls: "vlb-input",
			attr: { placeholder: "Passphrase", autocomplete: "off", spellcheck: "false" },
		});
		const line = contentEl.createDiv({ cls: "vlb-error" });
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		const btn = buttons.createEl("button", { text: "Unlock", cls: "mod-cta" });

		// Errors in the error colour, "Unlocking… n of N" muted.
		const say = (text: string, error: boolean) => {
			line.setText(text);
			line.toggleClass("vlb-progress", !error);
		};
		this.progressFn = (t) => say(t ?? "", false);

		let pending = false;
		const submit = async () => {
			if (pending || this.isClosed) return;
			pending = true;
			btn.disabled = true;
			say("", true);
			this.pf.progress = this.progressFn;
			let ok = false;
			try {
				ok = await this.lockScreen.tryUnlock(input.value, (t) => say(t, true));
			} catch (e) {
				console.error("[VLB] unlock failed", e);
				say("Could not unlock. Try again.", true);
			}
			pending = false;
			if (this.isClosed) return;
			if (ok && !this.lockScreen.locked) { this.close(); return; }
			// Wrong passphrase, or the folder could not be opened (the line says why).
			if (!ok) say("Wrong passphrase", true);
			input.value = "";
			btn.disabled = false;
			input.focus();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); void submit(); }
		});
		btn.addEventListener("click", () => void submit());
		window.setTimeout(() => input.focus(), 30);
	}

	onClose(): void {
		this.isClosed = true;
		if (this.pf.progress === this.progressFn) this.pf.progress = null;
		this.contentEl.empty();
		this.resolveClosed();
	}
}
