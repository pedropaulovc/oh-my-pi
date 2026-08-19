/** Incrementally reports complete, non-empty output lines with bounded partial state. */
export class ProgressLines {
	static readonly MAX_LINE_CHARS = 4_000;
	readonly #report: (line: string) => void;
	#partial = "";

	constructor(report: (line: string) => void) {
		this.#report = report;
	}

	append(chunk: string): void {
		let start = 0;
		let newline = chunk.indexOf("\n");
		while (newline !== -1) {
			this.#appendPartial(chunk.slice(start, newline));
			this.#reportLine(this.#partial);
			this.#partial = "";
			start = newline + 1;
			newline = chunk.indexOf("\n", start);
		}
		if (start < chunk.length) this.#appendPartial(chunk.slice(start));
	}

	finish(): void {
		if (this.#partial === "") return;
		const line = this.#partial;
		this.#partial = "";
		this.#reportLine(line);
	}

	reset(): void {
		this.#partial = "";
	}

	#appendPartial(segment: string): void {
		if (segment.length >= ProgressLines.MAX_LINE_CHARS) {
			this.#partial = segment.slice(-ProgressLines.MAX_LINE_CHARS);
			return;
		}
		const keep = ProgressLines.MAX_LINE_CHARS - segment.length;
		this.#partial = `${this.#partial.slice(-keep)}${segment}`;
	}

	#reportLine(rawLine: string): void {
		const line = rawLine.replace(/\r$/, "");
		if (line.trim().length === 0) return;
		this.#report(line);
	}
}
