// Node.js 22+ synchronous module resolution hook so `node --test` can import
// extensionless TypeScript modules across `workers/` and `shared/` without extra tooling.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (err) {
			if (
				(specifier.startsWith("./") || specifier.startsWith("../")) &&
				context.parentURL
			) {
				const parentDir = dirname(fileURLToPath(context.parentURL));
				const base = resolve(parentDir, specifier);
				for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
					if (existsSync(candidate)) {
						return nextResolve(pathToFileURL(candidate).href, context);
					}
				}
			}
			throw err;
		}
	},
});
