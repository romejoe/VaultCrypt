import {App, ButtonComponent, Modal, Setting} from 'obsidian';

export function generatePassword(
	length = 20,
	opts: { upper: boolean; lower: boolean; digits: boolean; symbols: boolean } = {
		upper: true, lower: true, digits: true, symbols: true,
	},
): string {
	let charset = '';
	if (opts.upper) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	if (opts.lower) charset += 'abcdefghijklmnopqrstuvwxyz';
	if (opts.digits) charset += '0123456789';
	if (opts.symbols) charset += '!@#$%^&*()-_=+[]{}|;:,.<>?';
	if (!charset) throw new Error('Enable at least one character set');

	const result: string[] = [];
	const max = Math.floor(0xffffffff / charset.length) * charset.length;
	while (result.length < length) {
		const buf = new Uint32Array(length * 2);
		crypto.getRandomValues(buf);
		for (const val of buf) {
			if (result.length >= length) break;
			if (val < max) result.push(charset[val % charset.length]!);
		}
	}
	return result.join('');
}

export class GeneratePasswordModal extends Modal {
	private onApply: (pw: string) => void;
	private length = 20;
	private opts = {upper: true, lower: true, digits: true, symbols: true};
	private currentPassword: string;
	private previewEl!: HTMLElement;
	private errorEl!: HTMLElement;
	private applyBtn!: ButtonComponent;

	constructor(app: App, onApply: (pw: string) => void) {
		super(app);
		this.onApply = onApply;
		this.currentPassword = generatePassword(this.length, this.opts);
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText('Generate password');

		new Setting(contentEl)
			.setName('Length')
			.addSlider(slider => slider
				.setLimits(8, 64, 1)
				.setValue(this.length)
				.setDynamicTooltip()
				.onChange(v => {
					this.length = v;
					this.refreshPreview();
				}));

		new Setting(contentEl)
			.setName('Uppercase letters')
			.addToggle(t => t.setValue(this.opts.upper).onChange(v => {
				this.opts.upper = v;
				this.refreshPreview();
			}));

		new Setting(contentEl)
			.setName('Lowercase letters')
			.addToggle(t => t.setValue(this.opts.lower).onChange(v => {
				this.opts.lower = v;
				this.refreshPreview();
			}));

		new Setting(contentEl)
			.setName('Digits')
			.addToggle(t => t.setValue(this.opts.digits).onChange(v => {
				this.opts.digits = v;
				this.refreshPreview();
			}));

		new Setting(contentEl)
			.setName('Symbols')
			.addToggle(t => t.setValue(this.opts.symbols).onChange(v => {
				this.opts.symbols = v;
				this.refreshPreview();
			}));

		const previewSetting = new Setting(contentEl).setName('Preview');
		this.previewEl = previewSetting.controlEl.createEl('code', {
			text: this.currentPassword,
			cls: 'vaultcrypt-password-preview',
		});
		previewSetting.addButton(btn => btn
			.setIcon('refresh-cw')
			.setTooltip('Regenerate')
			.onClick(() => this.refreshPreview()));

		this.errorEl = contentEl.createEl('p', {cls: 'mod-warning vaultcrypt-hidden'});

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(btn => {
				this.applyBtn = btn;
				btn.setButtonText('Apply')
					.setCta()
					.onClick(() => {
						this.onApply(this.currentPassword);
						this.close();
					});
			});
	}

	private refreshPreview() {
		const hasCharset = this.opts.upper || this.opts.lower || this.opts.digits || this.opts.symbols;
		if (!hasCharset) {
			this.currentPassword = '';
			this.previewEl?.setText('');
			this.errorEl.textContent = 'Enable at least one character set';
			this.errorEl.removeClass('vaultcrypt-hidden');
			this.applyBtn?.setDisabled(true);
			return;
		}
		this.errorEl.addClass('vaultcrypt-hidden');
		this.applyBtn?.setDisabled(false);
		this.currentPassword = generatePassword(this.length, this.opts);
		this.previewEl?.setText(this.currentPassword);
	}

	onClose() {
		this.contentEl.empty();
	}
}
