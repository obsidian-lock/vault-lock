/** Compare dotted versions segment by segment: 1.10.0 > 1.9.9, 1.7 == 1.7.0. Anything after "-" is ignored. */
export function cmpVersion(a: string, b: string): number {
	const parts = (v: string) => v.split("-")[0].split(".").map((x) => parseInt(x, 10) || 0);
	const pa = parts(a), pb = parts(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d > 0 ? 1 : -1;
	}
	return 0;
}
