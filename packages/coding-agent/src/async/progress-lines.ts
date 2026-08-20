export interface ProgressLine {
	text: string;
	truncated: boolean;
}

/** Incrementally reports complete, non-empty output lines with bounded partial state. */
export class ProgressLines {
	static readonly MAX_LINE_CHARS = 4_000;
	readonly #report: (line: ProgressLine) => void;
	#partial = "";
	#truncated = false;

	constructor(report: (line: ProgressLine) => void) {
		this.#report = report;
	}

	append(chunk: string): void {
		let start = 0;
		let newline = chunk.indexOf("\n");
		while (newline !== -1) {
			this.#appendPartial(chunk.slice(start, newline));
			this.#reportLine(this.#partial);
			this.#partial = "";
			this.#truncated = false;
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
		this.#truncated = false;
	}

	reset(): void {
		this.#partial = "";
		this.#truncated = false;
	}

	#appendPartial(segment: string): void {
		if (segment.length >= ProgressLines.MAX_LINE_CHARS) {
			this.#partial = segment.slice(-ProgressLines.MAX_LINE_CHARS);
			this.#truncated = true;
			return;
		}
		const keep = ProgressLines.MAX_LINE_CHARS - segment.length;
		if (this.#partial.length > keep) this.#truncated = true;
		this.#partial = `${this.#partial.slice(-keep)}${segment}`;
	}

	#reportLine(rawLine: string): void {
		const line = rawLine.replace(/\r$/, "");
		if (line.trim().length === 0) return;
		this.#report({ text: line, truncated: this.#truncated });
	}
}
