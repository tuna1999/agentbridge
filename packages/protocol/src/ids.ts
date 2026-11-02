/** UUIDv7 identifiers. Bun 1.4 provides `Bun.randomUUIDv7()` natively. */
export function newId(): string {
	return Bun.randomUUIDv7();
}
