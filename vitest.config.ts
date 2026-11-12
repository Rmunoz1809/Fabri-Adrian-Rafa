import { configDefaults, defineConfig } from "vitest/config";

// holo-pay/ is a separate project with its own config and tests (cd holo-pay && npm test).
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "holo-pay/**"] },
});
