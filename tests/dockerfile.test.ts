import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("Dockerfile", () => {
  it("starts the persistent service and does not run the benchmark", () => {
    const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.match(docker, /src\/main\.ts/);
    assert.doesNotMatch(docker, /src\/bench\.ts/);
    assert.match(pkg.scripts.start ?? "", /src\/main\.ts/);
    assert.match(pkg.scripts.bench ?? "", /src\/bench\.ts/);
    assert.equal(pkg.scripts.start === pkg.scripts.bench, false);
  });
});
