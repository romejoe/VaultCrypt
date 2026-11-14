/** Keep chip actions from moving the editor cursor, while allowing value selection. */
export function protectChipControls(root: HTMLElement): void {
	// Obsidian activates rendered table cells on pointerdown, before mouse handlers.
	// Keep native selection/focus inside the chip without entering the cell editor.
	root.addEventListener('pointerdown', (event) => event.stopPropagation());

	function isControl(event: MouseEvent): boolean {
		if (!(event.target instanceof Element)) return false;
		const control = event.target.closest('.vaultcrypt-chip-locked, .vaultcrypt-chip-btn, .vaultcrypt-chip-icon, .vaultcrypt-chip-dots');
		return control !== null && root.contains(control);
	}

	root.addEventListener('mousedown', (event) => {
		if (event.button !== 0 || !isControl(event)) return;
		event.preventDefault();
		event.stopPropagation();
	});

	root.addEventListener('click', (event) => {
		if (!isControl(event)) return;
		// A render can otherwise move a selection in the old value to the token boundary.
		// Capture also handles keyboard activation before the control's click handler runs.
		const selection = root.ownerDocument.getSelection();
		if (selection && root.contains(selection.anchorNode) && root.contains(selection.focusNode)) {
			selection.removeAllRanges();
		}
	}, {capture: true});
}
